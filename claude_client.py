"""
Anthropic API calls that do the actual judgment work: scoring each post 0-5,
flagging influencers, and drafting comments/connection notes/DMs. This is the
direct port of SKILL.md STEP 3 and STEP 6 — keep both in sync if either
changes. The rubric text below is copied near-verbatim from SKILL.md on
purpose, not paraphrased, so quality doesn't drift between the interactive
skill and this hosted version.
"""

import os
from anthropic import AsyncAnthropic

MODEL = "claude-sonnet-5"

_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


SCORE_TOOL = {
    "name": "submit_score",
    "description": "Submit the buying-intent score and influencer flag for this post.",
    # Marks the end of the cacheable "tools" prefix block (see the system
    # param in score_post below for the bigger cache win — this one is
    # small enough on its own that it may fall under the 1024-token
    # minimum to actually cache, but it's free to mark and helps once/if
    # the schema grows.
    "cache_control": {"type": "ephemeral"},
    "input_schema": {
        "type": "object",
        "properties": {
            "score": {
                "type": "integer",
                "minimum": 0,
                "maximum": 5,
                "description": "0-5 per the rubric in the system prompt.",
            },
            "scoreReasoning": {"type": "string"},
            "skipReason": {
                "type": ["string", "null"],
                "description": "Required if score is 0 — why this is a false positive or recruitment post.",
            },
            "isHiringSignal": {
                "type": "boolean",
                "description": "True if score 0 because it's a hiring post for a role owning this product's problem space.",
            },
            "isInfluencer": {
                "type": "boolean",
                "description": "True if this poster is an agency/consultant/advisor whose recommendation reaches many client accounts, per the influencer flag rule.",
            },
            "influencerReasoning": {"type": "string"},
        },
        "required": ["score", "scoreReasoning", "isInfluencer"],
    },
}

REPLY_TOOL = {
    "name": "submit_reply",
    "description": "Submit a drafted reply continuing an existing comment thread.",
    "cache_control": {"type": "ephemeral"},
    "input_schema": {
        "type": "object",
        "properties": {"replyText": {"type": "string"}},
        "required": ["replyText"],
    },
}

DRAFT_TOOL = {
    "name": "submit_draft",
    "description": "Submit the drafted comment and, if applicable, connection note and DM.",
    "cache_control": {"type": "ephemeral"},
    "input_schema": {
        "type": "object",
        "properties": {
            "comment": {"type": "string"},
            "connectionNote": {
                "type": ["string", "null"],
                "description": "<=200 chars. Only if action is comment+connect.",
            },
            "dmMessage": {
                "type": ["string", "null"],
                "description": "Only if action is comment+connect.",
            },
        },
        "required": ["comment"],
    },
}

SCORE_SYSTEM_PROMPT = """You are scoring a LinkedIn post for buying intent toward {product_name}.

{product_positioning}

Read the post's full text and apply this rubric. "Pain point" below means either
a STATED complaint/frustration, OR an IMPLICIT gap: the product positioning above
may describe a specific activity or artifact (shipped a certain kind of thing,
used a certain kind of tool, hit a certain milestone) that reveals a real unmet
need even when the poster hasn't said so and may not even know the gap exists yet
— that still counts as a pain point for scoring purposes if the positioning above
describes that pattern as part of the target customer's situation. Don't require
the poster to be self-aware of the need; some products (e.g. ones that complete an
unfinished workflow rather than fix a stated complaint) are bought by people who
didn't know to look for them until someone pointed out the gap.

0 = Skip — false positive (keyword matched but off-topic), or a recruitment/hiring post.
    If it's a hiring post for a role that owns this product's problem space, set
    isHiringSignal=true (a company building out this capability is a different,
    often stronger lead, but not a comment target).
1 = Thin or engagement-bait content — a poll, a one-line teaser, no real substance
    to respond to.
2 = Educational/thought-leadership content with no personal angle, or the poster's
    situation clearly doesn't match the target customer described in the product
    positioning above (check that description, not a generic assumption about
    persona or seniority — the right persona varies a lot by product).
3 = Genuine practitioner opinion or experience, OR the poster's situation loosely
    resembles the target customer but the match is thin or ambiguous. Good
    rapport-building opportunity either way. No clear pain point (stated or
    implicit per above) yet.
4 = Post reveals an active pain point or dissatisfaction with a current approach/
    tool, the author is evaluating options, OR the poster's own described
    activity/artifact is a clear, specific match for the implicit-gap pattern the
    product positioning describes as its target customer's situation.
5 = Explicit ask for a tool/solution recommendation, or a stated gap this specific
    product fills in their own words, however that gap is framed. Rare, high-value.

Be honest about the distribution — most posts from a broad keyword search are 1-3s.
Don't inflate scores to manufacture 5s. But don't undersell a 4 or 5 just because
of tone or tense:
- Proud/excited beats frustrated: someone showcasing exactly the kind of thing this
  product's positioning says its buyers have just built or shipped is a real lead,
  even celebratory, not complaining.
- Past tense/resolved beats "must be currently stuck": someone who explicitly
  names this product's exact problem in their own words — even while giving
  advice, writing up a lesson learned, or describing how they already worked
  around it — has still fully articulated the gap. That's a 5 regardless of
  whether they personally still have the problem right now. A post can say
  "I just avoided this" or "here's how I dealt with it" and still be the
  clearest possible statement of the gap this product fills — don't downgrade it
  to educational/thought-leadership just because it reads as settled rather than
  urgent.

Separately from the score, flag isInfluencer=true when the post itself signals the
author is an agency, consultant, or advisor whose recommendation reaches many client
accounts, not a single personal buyer — language like "we evaluate X for clients,"
"our preferred platform for most engagements," or naming genuinely different client
companies/brands. A post can score low on personal pain (2-3) and still be an
influencer, since they're not shopping for themselves.

Call submit_score with your verdict."""

DRAFT_SYSTEM_PROMPT = """You are drafting engagement content for a LinkedIn post, for {product_name}.

{product_positioning}

Comment style rules — apply to every comment:
- No em-dashes. Plain commas and full stops — em-dashes are a known AI writing tell
  and read as inauthentic.
- Reference something SPECIFIC from the actual post — a number, a claim, a detail.
  Generic comments ("Great point!") don't count.
- Value-add first. The comment should be worth reading even if the reader never
  becomes a lead.
- If the product positioning above describes an implicit-gap pattern (the poster's
  own described activity or artifact reveals a need they likely haven't addressed,
  even though the post itself doesn't complain about it), the comment's question
  should probe THAT specific gap directly — e.g. for a product that gets web-built
  apps into app stores, ask whether it's live on the App Store yet or whether push
  notifications are planned. That reads as genuine curiosity, not a pitch, and is
  more useful than a generic technical question about how the post's demo was built
  (how an API integration went, how a sync was implemented) which doesn't move the
  conversation toward the gap this product actually fills. This applies to the
  public comment itself, not just the DM — a plausible-sounding question about
  launch/distribution status doesn't name the product and isn't salesy.
- Only mention {product_name} by name in the comment if score is 4 (soft, "tools
  exist for this") or 5 (direct, "worth checking out X"). At any other score, or for
  an influencer flagged below score 4, the public comment has NO product mention —
  product curiosity is reserved for the private DM only.
- If you do name {product_name} and want to point them somewhere, cite exactly this
  URL: {landing_page_url}. Never the bare root domain or a different path, even if
  the positioning above happens to mention the domain in a shorter form elsewhere —
  this is the specific page built for this audience, not the general homepage. If no
  landing page URL is given (blank above), don't cite any URL at all — name the
  product without a link rather than guessing one.
- Sound like a real person typing, not a marketing team. Short, direct sentences.

If action is "comment+connect", also draft a connectionNote (<=200 chars, LinkedIn's
hard limit on the note field) and a dmMessage (sent after they accept, not before).
The voice differs by why they qualified:

- Direct buyer (score 5): they stated a personal need. Note references their specific
  ask in one line, no pitch in the note itself. DM responds directly to what they
  asked for — this is the one case where naming the product and inviting them to
  check it out is earned, because they asked. Still no hard sell or link-dump.

- Influencer: they weren't asking for anything personally — connecting is peer-to-peer,
  about their expertise/reach, not their need. Note references what's impressive or
  distinctive about THEIR work (breadth of clients/brands, depth of a framework, a
  specific stat), framed as wanting to connect and swap notes, not solve their
  problem. DM stays peer-to-peer: a genuine question about how they currently handle
  the relevant workflow across their clients/engagements. The product can come up as
  a curious aside, never a pitch to switch them personally — they're not the buyer,
  their clients would be.

If action is "comment" (no connect), leave connectionNote and dmMessage null.

Call submit_draft with your result."""

VOICE_ADDENDUM = """

The person posting this comment has their own writing voice — apply it on top of
everything above (the em-dash rule and specificity rule still apply regardless):
{voice_brief}
{length_line}
{style_line}"""

LENGTH_LINES = {
    "short": "Keep it short — a sentence or two, not a paragraph.",
    "long": "A fuller comment is fine here — two to four sentences.",
}
STYLE_LINES = {
    "casual": "Lean casual — contractions, informal phrasing, like texting a peer.",
    "professional": "Lean professional — complete sentences, no slang, still human and direct.",
}


async def score_post(product_config: dict, post_text: str) -> dict:
    client = _get_client()
    system = SCORE_SYSTEM_PROMPT.format(
        product_name=product_config["name"],
        product_positioning=product_config["positioning"],
    )
    # This system prompt is byte-identical across every candidate scored
    # for the same product within a scan (pipeline.py's _gather_limited
    # runs up to 50 per profile, 5 at a time) — only the post text in the
    # user message differs call to call. Marking it cacheable turns calls
    # 2-50 of every scan into cache reads (90% cheaper, faster) instead of
    # reprocessing the full product positioning from scratch each time.
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=[SCORE_TOOL],
        tool_choice={"type": "tool", "name": "submit_score"},
        messages=[{"role": "user", "content": f"Post:\n\n{post_text}"}],
    )
    result = _extract_tool_input(resp, "submit_score")
    # tool_choice forces the model to call submit_score, but doesn't
    # guarantee every required field actually lands in the input — a
    # response missing "score" used to crash the whole phase-1 scan with a
    # bare KeyError, losing every already-scored candidate in the same
    # batch since the Airtable write only happens once at the end. Raising
    # here instead turns it into a normal per-candidate scoring failure
    # (caught by _gather_limited's return_exceptions=True in pipeline.py),
    # same as any other Claude API error.
    if not isinstance(result.get("score"), int) or not (0 <= result["score"] <= 5):
        raise ValueError(f"submit_score returned an invalid score: {result.get('score')!r}")
    return result


async def draft_content(
    product_config: dict,
    post_text: str,
    score: int,
    is_influencer: bool,
    action: str,
    connect_reason: str | None,
    voice_profile: dict | None = None,
) -> dict:
    client = _get_client()
    system = DRAFT_SYSTEM_PROMPT.format(
        product_name=product_config["name"],
        product_positioning=product_config["positioning"],
        landing_page_url=product_config.get("landing_page_url") or "(none given)",
    )
    if voice_profile and voice_profile.get("voiceBrief"):
        system += VOICE_ADDENDUM.format(
            voice_brief=voice_profile["voiceBrief"],
            length_line=LENGTH_LINES.get(voice_profile.get("replyLength"), ""),
            style_line=STYLE_LINES.get(voice_profile.get("replyStyle"), ""),
        )
    context = (
        f"Post:\n\n{post_text}\n\n"
        f"Score: {score}\nisInfluencer: {is_influencer}\naction: {action}\n"
        f"connectReason: {connect_reason}"
    )
    # Same cacheable-prefix reasoning as score_post above — this system
    # prompt (product positioning + voice addendum, when present) is
    # identical across every draft_content call for the same product/
    # customer within a batch.
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=[DRAFT_TOOL],
        tool_choice={"type": "tool", "name": "submit_draft"},
        messages=[{"role": "user", "content": context}],
    )
    result = _extract_tool_input(resp, "submit_draft")
    # DRAFT_TOOL marks "comment" required but has no minLength, so a
    # response with comment: "" satisfies the schema without erroring —
    # same class of gap score_post() already guards against for "score"
    # above. Live bug (2026-07-20): a qualified, non-skip candidate reached
    # the Queue with a permanently empty Comment field because this came
    # back empty and nothing caught it. Raising here routes it into the
    # same caught-per-candidate-failure path pipeline.py already has for a
    # thrown exception, instead of silently passing an empty draft through.
    if not (result.get("comment") or "").strip():
        raise ValueError("submit_draft returned an empty comment")
    return result


REPLY_SYSTEM_PROMPT = """You are continuing a LinkedIn comment conversation.
{product_section}
Context: you (on behalf of the person using this tool) already left a comment on
someone's post. They've now replied to that comment. Draft a natural, human-sounding
reply that continues the thread.

Rules — same bar as any comment:
- No em-dashes. Plain commas and full stops.
- Reference something SPECIFIC from their reply, not just the original post — they
  took the time to respond, the follow-up should show you actually read it.
- Keep it short. A reply is a sentence or two, not a re-pitch of the whole thread.
- Sound like a real person continuing a conversation, not restarting a script.
- The whole point of this reply is to keep moving toward finding out whether they
  have an actual unresolved gap this product fills — not just to keep chatting. The
  product positioning above usually covers more than one distinct pain point (e.g.
  submission/distribution, AND push notifications, AND ongoing updates/subscriptions
  — check what's actually listed). If their reply CONFIRMS one of those points is
  already handled for them (they state a fact that answers it, e.g. "I already have
  5 apps live" answers "have you submitted to the App Store yet"), do not keep
  probing that same confirmed point. Briefly acknowledge what they said, in one
  clause, then pivot the actual question to a DIFFERENT pain point from the
  positioning that hasn't been confirmed either way yet.
- When more than one unconfirmed pain point is available to pivot to, don't just
  pick any of them — rank by which is a genuine CAPABILITY GAP versus a mere
  WORKFLOW-FRICTION point, and prefer the capability gap. A capability gap is
  something the underlying tool/platform they're already using structurally cannot
  do on its own (e.g. native push notifications on a WebView-wrapped app) — they
  likely haven't even clocked it as a missing piece, so asking about it creates a
  real "wait, I don't have that" moment. A workflow-friction point is just a minor
  inconvenience within something they can already do (e.g. whether re-publishing an
  app they've already got live is mildly annoying) — easy to shrug off with "it's
  fine," and a much weaker opener. If the confirmed part of their reply already
  covers the friction point too (e.g. having apps live at all implies publishing
  works), that's an extra reason to skip it and go straight for the capability gap.
  If EVERY distinct pain point this product addresses has now been confirmed as
  already handled, don't invent a new angle just to keep the thread going — a short
  genuine reaction with no new question is the honest move, and better than looking
  like you didn't register what they told you.
{product_mention_rule}

The original post, your prior comment, and their reply are given in the user
message below. Call submit_reply with your draft."""

# Kept out of the system prompt on purpose (post_text/own_comment/reply_text
# differ on every single call, unlike everything above) — baking them into
# system would make the system prompt unique per call and defeat caching
# entirely, even though product_section/product_mention_rule above are
# identical across every reply drafted for the same product.
REPLY_USER_MESSAGE = """Score: {score}

Original post: {post_text}

Your prior comment: {own_comment}

Their reply: {reply_text}"""

# Filled in when a product could be identified (an Airtable match, or a
# decent keyword-inference score against scraped page text).
_PRODUCT_SECTION = "\nFor {product_name}:\n\n{product_positioning}\n"
_PRODUCT_MENTION_RULE = """- Only mention {product_name} by name if the ORIGINAL score was 4 or 5 AND their
  reply itself opens the door (asks a question you can answer with it, expresses
  continued interest, or states the gap more explicitly than before). If their
  reply is just polite/conversational with no opening, keep building rapport
  instead, no product mention yet — better to earn a second exchange than force it.
- If their reply reveals a real objection or reason this product wouldn't fit them,
  don't paper over it. Acknowledge it honestly rather than pushing past it.
- If you do name {product_name} and want to point them somewhere, cite exactly this
  URL: {landing_page_url}. Never the bare root domain or a different path. If no
  landing page URL is given (blank), don't cite any URL at all."""
# No product identified — never guess or mention one. Pure rapport-building
# continuation is always safe; a wrong product mention is not.
_NO_PRODUCT_MENTION_RULE = "- No product context is available for this thread — do not name or imply any product. Keep this purely about continuing the conversation and building rapport."


async def draft_reply(
    product_config: dict | None,
    post_text: str,
    own_comment: str,
    reply_text: str,
    score: int,
    voice_profile: dict | None = None,
) -> dict:
    client = _get_client()
    if product_config:
        product_section = _PRODUCT_SECTION.format(
            product_name=product_config["name"], product_positioning=product_config["positioning"]
        )
        product_mention_rule = _PRODUCT_MENTION_RULE.format(
            product_name=product_config["name"],
            landing_page_url=product_config.get("landing_page_url") or "(none given)",
        )
    else:
        product_section = ""
        product_mention_rule = _NO_PRODUCT_MENTION_RULE
    system = REPLY_SYSTEM_PROMPT.format(
        product_section=product_section,
        product_mention_rule=product_mention_rule,
    )
    if voice_profile and voice_profile.get("voiceBrief"):
        system += VOICE_ADDENDUM.format(
            voice_brief=voice_profile["voiceBrief"],
            length_line=LENGTH_LINES.get(voice_profile.get("replyLength"), ""),
            style_line=STYLE_LINES.get(voice_profile.get("replyStyle"), ""),
        )
    user_message = REPLY_USER_MESSAGE.format(
        score=score, post_text=post_text, own_comment=own_comment, reply_text=reply_text
    )
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        tools=[REPLY_TOOL],
        tool_choice={"type": "tool", "name": "submit_reply"},
        messages=[{"role": "user", "content": user_message}],
    )
    return _extract_tool_input(resp, "submit_reply")


def _extract_tool_input(response, tool_name: str) -> dict:
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise ValueError(f"Model didn't call {tool_name}: {response.content}")
