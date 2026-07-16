"""
MCP client wrapper for RichAPI.

RichAPI is exposed as a hosted MCP server (not a plain REST API), the same
one this Claude Code session talks to — found in ~/.claude.json:
  { "type": "http", "url": "https://mcp.richapi.ai/mcp", "headers": {"x-api-key": "..."} }

So instead of reverse-engineering a REST contract, this backend is itself an
MCP client connecting to that same server, calling the same tools
(post_keyword_search, enrich_profile, enrich_company, find_emails,
verify_emails, check_email_finding, check_email_verification, check_usage)
with the same behavior already verified interactively in this project.

CORRECTED after the first live deploy failed with:
  ModuleNotFoundError: No module named 'mcp.client.streamable_http'
That was because requirements.txt had pinned mcp==1.1.2, which predates the
streamable-HTTP transport module entirely. Fixed by pinning mcp==1.28.1 (the
current stable release, verified by downloading and inspecting the actual
wheel rather than guessing) and updating two real API differences found the
same way:
  1. The function is `streamable_http_client` (underscore between
     "streamable" and "http"), not `streamablehttp_client`.
  2. It no longer takes a `headers` kwarg directly — that's deprecated.
     Headers now go through a caller-supplied httpx.AsyncClient passed as
     `http_client=`. We own that client's lifecycle (create before, close
     after), since the transport won't manage a client it didn't create.
"""

import json
import os
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

RICHAPI_URL = "https://mcp.richapi.ai/mcp"


class RichAPIClient:
    """Async context manager — reuse one instance for a whole pipeline run
    rather than reconnecting per tool call."""

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ["RICHAPI_API_KEY"]
        self._http_client: httpx.AsyncClient | None = None
        self._streams_cm = None
        self._session_cm = None
        self.session: ClientSession | None = None

    async def __aenter__(self) -> "RichAPIClient":
        self._http_client = httpx.AsyncClient(headers={"x-api-key": self.api_key})
        self._streams_cm = streamable_http_client(RICHAPI_URL, http_client=self._http_client)
        read_stream, write_stream, _get_session_id = await self._streams_cm.__aenter__()
        self._session_cm = ClientSession(read_stream, write_stream)
        self.session = await self._session_cm.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, *exc_info):
        if self._session_cm is not None:
            await self._session_cm.__aexit__(*exc_info)
        if self._streams_cm is not None:
            await self._streams_cm.__aexit__(*exc_info)
        if self._http_client is not None:
            await self._http_client.aclose()

    async def call(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Call an MCP tool and parse its text content block as JSON.
        Unlike Claude Code's own MCP wrapper (which offloads oversized
        results to a file to protect the conversation context window), this
        is server-side code with no such constraint — the full parsed
        payload just comes back directly, no file juggling needed."""
        if self.session is None:
            raise RuntimeError("RichAPIClient used outside its 'async with' block")
        result = await self.session.call_tool(tool_name, arguments=arguments)
        text = "".join(getattr(block, "text", "") for block in result.content)
        return json.loads(text)

    async def poll(
        self,
        check_tool_name: str,
        job_id: str,
        interval_seconds: float = 3.0,
        max_attempts: int = 40,
    ) -> dict[str, Any]:
        """Shared polling loop for find_emails/verify_emails's async jobs."""
        import asyncio

        for _ in range(max_attempts):
            result = await self.call(check_tool_name, {"jobId": job_id})
            status = result.get("status")
            if status == "completed":
                return result
            if status == "failed":
                raise RuntimeError(f"{check_tool_name} job {job_id} failed: {result}")
            await asyncio.sleep(interval_seconds)
        raise TimeoutError(f"{check_tool_name} job {job_id} did not complete in time")
