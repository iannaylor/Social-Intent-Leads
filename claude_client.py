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
    "input_schema": {
        "type": "object",
        "properties": {"replyText": {"type": "string"}},
        "required": ["replyText"],
    },
}

DRAFT_TOOL = {
    "name": "submit_draft",
    "description": "Submit the drafted comment and, if applicable, connection note and DM.",
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
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
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
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        tools=[DRAFT_TOOL],
        tool_choice={"type": "tool", "name": "submit_draft"},
        messages=[{"role": "user", "content": context}],
    )
    return _extract_tool_input(resp, "submit_draft")


REPLY_SYSTEM_PROMPT = """You are continuing a LinkedIn comment conversation, for {product_name}.

{product_positioning}

Context: you (on behalf of the person using this tool) already left a comment on
someone's post. They've now replied to that comment. Draft a natural, human-sounding
reply that continues the thread.

Rules — same bar as any comment:
- No em-dashes. Plain commas and full stops.
- Reference something SPECIFIC from their reply, not just the original post — they
  took the time to respond, the follow-up should show you actually read it.
- Keep it short. A reply is a sentence or two, not a re-pitch of the whole thread.
- Sound like a real person continuing a conversation, not restarting a script.
- Only mention {product_name} by name if the ORIGINAL score was 4 or 5 AND their
  reply itself opens the door (asks a question you can answer with it, expresses
  continued interest, or states the gap more explicitly than before). If their
  reply is just polite/conversational with no opening, keep building rapport
  instead, no product mention yet — better to earn a second exchange than force it.
- If their reply reveals a real objection or reason this product wouldn't fit them,
  don't paper over it. Acknowledge it honestly rather than pushing past it.

Original post: {post_text}

Your prior comment: {own_comment}

Their reply: {reply_text}

Call submit_reply with your draft."""


async def draft_reply(
    product_config: dict,
    post_text: str,
    own_comment: str,
    reply_text: str,
    score: int,
    voice_profile: dict | None = None,
) -> dict:
    client = _get_client()
    system = REPLY_SYSTEM_PROMPT.format(
        product_name=product_config["name"],
        product_positioning=product_config["positioning"],
        post_text=post_text,
        own_comment=own_comment,
        reply_text=reply_text,
    )
    if voice_profile and voice_profile.get("voiceBrief"):
        system += VOICE_ADDENDUM.format(
            voice_brief=voice_profile["voiceBrief"],
            length_line=LENGTH_LINES.get(voice_profile.get("replyLength"), ""),
            style_line=STYLE_LINES.get(voice_profile.get("replyStyle"), ""),
        )
    resp = await client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system,
        tools=[REPLY_TOOL],
        tool_choice={"type": "tool", "name": "submit_reply"},
        messages=[{"role": "user", "content": f"Score: {score}"}],
    )
    return _extract_tool_input(resp, "submit_reply")


def _extract_tool_input(response, tool_name: str) -> dict:
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise ValueError(f"Model didn't call {tool_name}: {response.content}")
