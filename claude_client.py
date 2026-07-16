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

Read the post's full text and apply this rubric:

0 = Skip — false positive (keyword matched but off-topic), or a recruitment/hiring post.
    If it's a hiring post for a role that owns this product's problem space, set
    isHiringSignal=true (a company building out this capability is a different,
    often stronger lead, but not a comment target).
1 = Thin or engagement-bait content — a poll, a one-line teaser, no real substance
    to respond to.
2 = Educational/thought-leadership content, or wrong persona (engineer/data-scientist/
    journalist reporting news rather than a marketer with budget). No personal pain
    point evident.
3 = Genuine practitioner opinion or experience. Good rapport-building opportunity.
    No live pain point stated.
4 = Post reveals an active pain point or dissatisfaction with a current approach/tool,
    or the author is evaluating options.
5 = Explicit ask for a tool/solution recommendation, or a stated gap this specific
    product fills. Rare, high-value.

Be honest about the distribution — most posts from a broad keyword search are 1-3s.
Don't inflate scores to manufacture 5s.

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
    return _extract_tool_input(resp, "submit_score")


async def draft_content(
    product_config: dict,
    post_text: str,
    score: int,
    is_influencer: bool,
    action: str,
    connect_reason: str | None,
) -> dict:
    client = _get_client()
    system = DRAFT_SYSTEM_PROMPT.format(
        product_name=product_config["name"],
        product_positioning=product_config["positioning"],
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


def _extract_tool_input(response, tool_name: str) -> dict:
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise ValueError(f"Model didn't call {tool_name}: {response.content}")
