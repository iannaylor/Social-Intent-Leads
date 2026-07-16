"""
Generates a voice/tone brief from a person's own LinkedIn post history, so
their drafted comments sound like them rather than a generic AI voice.

NOTE: the exact shape of profile_activities' response items wasn't directly
observed in this session (only its tool description was available: "Returns
recent activity items"). _extract_text() below tries a few plausible field
names defensively. If voice briefs come back generic/empty on first live
use, that function is the first place to check — log the raw activity item
shape and adjust.
"""

from typing import Any

import claude_client
from richapi_client import RichAPIClient

VOICE_SYSTEM_PROMPT = """You are analyzing someone's real LinkedIn posts to write a short brief describing
their writing voice, so future comments can be drafted to sound like them.

Focus on concrete, actionable signals: typical sentence length, formality
level, use of contractions, how they open/close a thought, whether they use
em-dashes, bullet points, emoji, hashtags, industry jargon, humor, directness
vs hedging, first-person framing. Avoid vague adjectives like "engaging" or
"authentic" on their own — back every claim with what specifically causes
that impression.

Write 4-6 sentences, plain prose, no headers or bullet points. This brief
will be shown to the person for editing, and used verbatim as part of a
system prompt for future drafting — write it as direct, usable instruction
("Write in short, punchy sentences. Rarely uses emoji. Opens with a direct
claim, not a question."), not a description written about them in third
person for someone else to read."""


def _extract_text(activity: dict) -> str:
    for key in ("commentary", "text", "content", "summary"):
        value = activity.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


async def generate_voice_brief(linkedin_url: str) -> dict:
    """Returns {voiceBrief, postsAnalyzed}. Raises if the profile can't be
    resolved or has no usable post history."""
    async with RichAPIClient() as richapi:
        profile_data = await richapi.call("enrich_profile", {"url": linkedin_url})
        entity_urn = profile_data.get("entityUrn")
        if not entity_urn:
            raise ValueError("Could not resolve a LinkedIn entity URN for this profile URL.")

        activity_result = await richapi.call("profile_activities", {"urn": entity_urn, "type": "POST"})
        activities = activity_result.get("content") or activity_result.get("results") or activity_result.get("activities") or []
        if isinstance(activity_result, list):
            activities = activity_result

        samples = [_extract_text(a) for a in activities if isinstance(a, dict)]
        samples = [s for s in samples if s][:10]

    if not samples:
        raise ValueError("No usable posts found for this profile — can't generate a voice brief from an empty history.")

    joined = "\n\n---\n\n".join(samples)
    resp = await claude_client._get_client().messages.create(
        model=claude_client.MODEL,
        max_tokens=512,
        system=VOICE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Their recent posts:\n\n{joined}"}],
    )
    brief = "".join(block.text for block in resp.content if getattr(block, "type", None) == "text")
    return {"voiceBrief": brief.strip(), "postsAnalyzed": len(samples)}
