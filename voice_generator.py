"""
Drafts a voice/tone brief from the caller's own recent LinkedIn posts, so
their drafted comments sound like them rather than a generic AI voice.

Posts are scraped client-side (the Chrome extension's content.js, off the
caller's own recent-activity page in their own already-logged-in browser)
and passed in directly — this module never fetches anything itself.
Deliberately NOT RichAPI: RichAPI exists to find OTHER people's posts for
prospecting, and routing a read of the caller's OWN posts through a
third-party API added a real, unnecessary failure mode (rate limits,
timeouts, malformed responses) for a task that never needed one.
"""

import claude_client

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


async def generate_voice_brief(posts: list[str]) -> dict:
    """posts is the caller's own recent post texts, already scraped
    client-side — up to 10 are used even if more are passed in. Raises
    ValueError if there's nothing usable to draft from."""
    samples = [p.strip() for p in posts if isinstance(p, str) and p.strip()][:10]
    if not samples:
        raise ValueError("No usable posts found — can't generate a voice brief from an empty history.")

    joined = "\n\n---\n\n".join(samples)
    resp = await claude_client._get_client().messages.create(
        model=claude_client.MODEL,
        max_tokens=512,
        system=VOICE_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Their recent posts:\n\n{joined}"}],
    )
    brief = "".join(block.text for block in resp.content if getattr(block, "type", None) == "text")
    return {"voiceBrief": brief.strip(), "postsAnalyzed": len(samples)}
