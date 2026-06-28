"""mitmdump addon that captures claude's tool schemas from /messages requests.

Accumulates a union of tool schemas by exact tool name across every /messages
POST, and parses the deferred-tool roster from <system-reminder> blocks in
user message content. If a later request carries a different schema for an
already-seen tool, that is schema drift, recorded in the output as
`drift_detected` (capture.ts fails hard on it). Post-processing (validation,
filtering, provenance) lives in capture.ts — this addon records the raw
capture faithfully.

Usage (spawned by capture.ts):
  mitmdump -s capture-addon.py --set output_path=/tmp/raw-tools.json
"""

import json
import re

import mitmproxy.addonmanager
from mitmproxy import ctx
from mitmproxy import http


def parse_deferred_roster(text: str) -> list[str] | None:
    """Extract deferred tool names from claude's roster message.

    As of claude 2.1.211 the roster arrives as a role:"system" message (no
    <system-reminder> wrapper): an intro sentence ending in ":", then one
    tool name per line, then a blank line before unrelated content.
    """
    if "deferred tools" not in text.lower() or "ToolSearch" not in text:
        return None
    lines = text.splitlines()
    intro = next((i for i, line in enumerate(lines) if line.rstrip().endswith(":")), None)
    if intro is None:
        return None
    names = []
    for line in lines[intro + 1:]:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", line.strip()):
            break
        names.append(line.strip())
    return sorted(names) if names else None


class CaptureToolSchemas:
    def __init__(self):
        self.tools: dict[str, dict] = {}
        self.request_count = 0
        self.drift_detected = False
        self.roster: list[str] | None = None

    def load(self, loader: mitmproxy.addonmanager.Loader):
        loader.add_option(
            name="output_path",
            typespec=str,
            default="/tmp/tool_schemas.json",
            help="Path to write the raw captured tool schemas JSON",
        )

    def request(self, flow: http.HTTPFlow):
        if flow.request.method != "POST" or "/messages" not in flow.request.pretty_url:
            return
        try:
            body = json.loads(flow.request.get_text())
        except (json.JSONDecodeError, ValueError):
            return
        self.request_count += 1
        self._scan_roster(body)
        self._accumulate_tools(body)

    def _scan_roster(self, body: dict):
        for msg in body.get("messages", []):
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "text":
                    continue
                parsed = parse_deferred_roster(block.get("text", ""))
                if parsed is None:
                    continue
                if self.roster is None:
                    self.roster = parsed
                    ctx.log.info(f"Deferred roster ({len(parsed)}): {', '.join(parsed)}")
                elif set(parsed) - set(self.roster):
                    # A grown roster would mean the phase-1 capture missed
                    # names; treat like drift so the run is redone, not merged.
                    ctx.log.error(
                        f"FATAL: roster gained tools between requests: "
                        f"{sorted(set(parsed) - set(self.roster))}"
                    )
                    self.drift_detected = True

    def _accumulate_tools(self, body: dict):
        tools = body.get("tools")
        if not isinstance(tools, list):
            return
        new_count = 0
        for tool in tools:
            name = tool.get("name")
            if not name:
                continue
            if name in self.tools:
                existing = json.dumps(self.tools[name], sort_keys=True)
                incoming = json.dumps(tool, sort_keys=True)
                if existing != incoming:
                    ctx.log.error(
                        f"SCHEMA DRIFT for '{name}'!\n"
                        f"  Existing: {existing[:300]}\n"
                        f"  Incoming: {incoming[:300]}"
                    )
                    self.drift_detected = True
            else:
                self.tools[name] = tool
                new_count += 1
        self._write_output()
        ctx.log.info(
            f"Request {self.request_count}: +{new_count} new (total={len(self.tools)})"
        )

    def _write_output(self):
        output = {
            "tools": sorted(self.tools.values(), key=lambda t: t.get("name", "")),
            "deferred_tool_roster": self.roster,
            "drift_detected": self.drift_detected,
        }
        with open(ctx.options.output_path, "w") as f:
            json.dump(output, f, indent=2)
            f.write("\n")

    def done(self):
        self._write_output()
        if self.drift_detected:
            ctx.log.error("FATAL: schema drift detected")


addons = [CaptureToolSchemas()]
