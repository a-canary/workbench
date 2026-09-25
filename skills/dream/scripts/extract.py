#!/usr/bin/env python3
"""
Extract Claude conversation JSONL to structured YAML with compression tags.

Step 1 of the Dream Event Indexer pipeline:
- Parse JSONL conversation files
- Remove noise (progress, streaming, metadata)
- Keep all meaningful content (user messages, assistant messages, tool calls, results)
- Tag large fields (>1000 words) with <COMPRESS> markers for later compression
- Output structured YAML

Usage:
    python extract.py path/to/session.jsonl -o output.yaml
    python extract.py path/to/session.jsonl  # prints to stdout
"""

import argparse
import json
import re
import sys
from pathlib import Path
from collections import defaultdict
from datetime import datetime
from typing import Iterator

# Message types that are pure noise - always remove
NOISE_TYPES = {
    "progress",
    "agent_progress",
    "file-history-snapshot",
    "hook_progress",
    "streaming",
}

# Fields in messages that are metadata noise
NOISE_FIELDS = {
    "costUSD",
    "durationMs",
    "cacheCreationInputTokens",
    "cacheReadInputTokens",
    "inputTokens",
    "outputTokens",
    "uuid",
    "parentUuid",
    "isSidechain",
    "cwd",
    "toolUseResult",  # Duplicates tool_result content
}

# Word count threshold for compression tagging
COMPRESS_THRESHOLD = 1000

# When False, tag_if_large is a passthrough. page.py sets this off so windowed
# output carries no COMPRESS markers; standalone extract.py keeps it on.
TAGGING_ENABLED = True


def count_words(text: str) -> int:
    """Count words in text."""
    if not text:
        return 0
    return len(text.split())


def is_noise_message(msg: dict) -> bool:
    """Check if message is noise that should be removed entirely."""
    msg_type = msg.get("type", "")

    # Explicit noise types
    if msg_type in NOISE_TYPES:
        return True

    # Check nested message type
    if "message" in msg:
        inner = msg["message"]
        if isinstance(inner, dict):
            if inner.get("type", "") in NOISE_TYPES:
                return True

    # Empty content
    content = msg.get("content")
    if content is None:
        role = msg.get("role")
        if role is None:
            # No role, no content - likely metadata
            if "message" not in msg:
                return True

    return False


def extract_text_content(content) -> str:
    """Extract all text from content (string or blocks)."""
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        texts = []
        for block in content:
            if isinstance(block, dict):
                block_type = block.get("type", "")
                if block_type == "text":
                    texts.append(block.get("text", ""))
                elif block_type == "tool_result":
                    result = block.get("content", "")
                    if isinstance(result, str):
                        texts.append(result)
                    elif isinstance(result, list):
                        texts.append(extract_text_content(result))
                elif block_type == "thinking":
                    texts.append(block.get("thinking", ""))
            elif isinstance(block, str):
                texts.append(block)
        return "\n".join(texts)

    return ""


def tag_if_large(content: str, line_start: int, threshold: int = COMPRESS_THRESHOLD) -> str:
    """Wrap content in COMPRESS tags if it exceeds word threshold."""
    if not TAGGING_ENABLED:
        return content
    word_count = count_words(content)
    if word_count <= threshold:
        return content

    # Estimate line count (rough: ~10 words per line)
    line_count = max(1, word_count // 10)
    line_end = line_start + line_count

    return f"<COMPRESS>[{word_count} words, lines {line_start}-{line_end}]\n{content}\n</COMPRESS>"


def extract_tool_info(block: dict) -> dict:
    """Extract relevant info from a tool_use block."""
    tool_name = block.get("name", "unknown")
    tool_input = block.get("input", {})

    info = {
        "tool": tool_name,
    }

    # Extract key parameters based on tool type
    if tool_name == "Bash":
        info["command"] = tool_input.get("command", "")
        if "description" in tool_input:
            info["description"] = tool_input["description"]
    elif tool_name == "Read":
        info["file_path"] = tool_input.get("file_path", "")
    elif tool_name == "Write":
        info["file_path"] = tool_input.get("file_path", "")
        content = tool_input.get("content", "")
        info["content"] = content
    elif tool_name == "Edit":
        info["file_path"] = tool_input.get("file_path", "")
        info["old_string"] = tool_input.get("old_string", "")
        info["new_string"] = tool_input.get("new_string", "")
    elif tool_name == "Glob":
        info["pattern"] = tool_input.get("pattern", "")
    elif tool_name == "Grep":
        info["pattern"] = tool_input.get("pattern", "")
        if "path" in tool_input:
            info["path"] = tool_input["path"]
    elif tool_name == "Task":
        info["subagent_type"] = tool_input.get("subagent_type", "")
        info["prompt"] = tool_input.get("prompt", "")[:500]  # Truncate long prompts
    elif tool_name == "WebFetch":
        info["url"] = tool_input.get("url", "")
    elif tool_name == "WebSearch":
        info["query"] = tool_input.get("query", "")
    else:
        # Generic: include all input
        info["input"] = tool_input

    return info


# Map pi's lowercase tool names to the canonical Claude tool names so the
# per-tool field extraction (extract_tool_info) and any name-keyed downstream
# logic fire identically on both sources.
_PI_TOOL_NAMES = {
    "bash": "Bash", "read": "Read", "write": "Write", "edit": "Edit",
    "glob": "Glob", "grep": "Grep", "task": "Task", "webfetch": "WebFetch",
    "websearch": "WebSearch", "ls": "LS", "multiedit": "MultiEdit",
    "notebookedit": "NotebookEdit", "todowrite": "TodoWrite",
}


def canonicalize_message(inner: dict) -> dict:
    """Normalize a `pi` agent message to the canonical Claude JSONL shape.

    The two session sources diverge in their tool schema only:
      - pi assistant `toolCall` block {id,name,arguments} -> `tool_use` {id,name,input}
      - pi top-level `toolResult` role -> a `user` message carrying one
        `tool_result` block {tool_use_id,is_error,content}
    Interactive Claude Code already uses the canonical shape, so it passes
    through untouched. Everything downstream (role dispatch, tool linkage,
    waste detection) then works on one schema.
    """
    if not isinstance(inner, dict):
        return inner
    role = inner.get("role")

    # pi tool-result message -> canonical user/tool_result
    if role == "toolResult":
        return {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": inner.get("toolCallId", ""),
                "is_error": inner.get("isError", False),
                "content": inner.get("content", ""),
            }],
        }

    # pi assistant `toolCall` blocks -> canonical `tool_use` blocks
    content = inner.get("content")
    if isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "toolCall" for b in content
    ):
        new_content = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "toolCall":
                name = b.get("name", "unknown")
                new_content.append({
                    "type": "tool_use",
                    "id": b.get("id", ""),
                    "name": _PI_TOOL_NAMES.get(name, name),
                    "input": b.get("arguments", {}),
                })
            else:
                new_content.append(b)
        return {**inner, "content": new_content}

    return inner


def extract_message(msg: dict, line_num: int, index: int) -> dict | None:
    """Extract a clean message dict from raw JSONL message."""
    if is_noise_message(msg):
        return None

    result = {
        "index": index,
        "line": line_num,
    }

    # Handle nested message structure, then normalize `pi`-shaped tool records
    # to the canonical Claude schema so the dispatch below is source-agnostic.
    inner = msg["message"] if ("message" in msg and isinstance(msg["message"], dict)) else msg
    inner = canonicalize_message(inner)
    role = inner.get("role")
    content = inner.get("content")

    # Determine message type
    msg_type = msg.get("type", "")

    if role == "user":
        result["role"] = "user"

        # Check if this is a tool result
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    result["role"] = "tool_result"
                    result["tool_use_id"] = block.get("tool_use_id", "")
                    result["is_error"] = block.get("is_error", False)

                    tool_content = block.get("content", "")
                    if isinstance(tool_content, str):
                        result["content"] = tag_if_large(tool_content, line_num)
                    elif isinstance(tool_content, list):
                        extracted = extract_text_content(tool_content)
                        result["content"] = tag_if_large(extracted, line_num)
                    else:
                        result["content"] = str(tool_content)
                    return result

        # Regular user message
        if isinstance(content, str):
            result["content"] = content
        elif isinstance(content, list):
            texts = []
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        texts.append(block.get("text", ""))
                elif isinstance(block, str):
                    texts.append(block)
            result["content"] = "\n".join(texts) if texts else ""
        else:
            result["content"] = str(content) if content else ""

        # Check for interrupt
        if result["content"].strip() == "[interrupt]":
            result["is_interrupt"] = True

    elif role == "assistant":
        result["role"] = "assistant"

        if isinstance(content, list):
            # Check for tool use
            for block in content:
                if isinstance(block, dict):
                    block_type = block.get("type", "")

                    if block_type == "tool_use":
                        result["role"] = "tool_use"
                        result.update(extract_tool_info(block))
                        result["tool_use_id"] = block.get("id", "")
                        return result

                    elif block_type == "text":
                        text = block.get("text", "")
                        if text:
                            result["content"] = tag_if_large(text, line_num)
                            return result

                    elif block_type == "thinking":
                        # Keep thinking blocks but tag if large
                        thinking = block.get("thinking", "")
                        if thinking:
                            result["thinking"] = tag_if_large(thinking, line_num)
        elif isinstance(content, str):
            result["content"] = tag_if_large(content, line_num)
        else:
            result["content"] = str(content) if content else ""

    else:
        # Unknown role - keep it anyway with available info
        if role:
            result["role"] = role
        elif msg_type:
            result["role"] = msg_type
        else:
            return None  # Can't determine type, skip

        if content:
            if isinstance(content, str):
                result["content"] = tag_if_large(content, line_num)
            else:
                result["content"] = tag_if_large(extract_text_content(content), line_num)

    return result


def parse_jsonl(filepath: Path) -> tuple[list[dict], dict]:
    """Parse JSONL file and return messages and metadata."""
    messages = []
    metadata = {
        "session_id": filepath.stem,
        "project": filepath.parent.name,
        "source_file": str(filepath),
    }

    tool_counts = defaultdict(int)
    message_index = 0

    with open(filepath, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Extract timestamp from first message if available
            if "timestamp" in msg and "timestamp" not in metadata:
                metadata["timestamp"] = msg["timestamp"]

            extracted = extract_message(msg, line_num, message_index)
            if extracted:
                messages.append(extracted)
                message_index += 1

                # Track tool usage
                if extracted.get("role") == "tool_use":
                    tool_name = extracted.get("tool", "unknown")
                    tool_counts[tool_name] += 1

    metadata["message_count"] = len(messages)
    metadata["tool_counts"] = dict(tool_counts)

    return messages, metadata


def to_yaml(messages: list[dict], metadata: dict) -> str:
    """Convert messages and metadata to YAML string."""
    lines = []

    # Metadata header
    lines.append(f"session_id: \"{metadata['session_id']}\"")
    lines.append(f"project: \"{metadata['project']}\"")
    if "timestamp" in metadata:
        lines.append(f"timestamp: \"{metadata['timestamp']}\"")
    lines.append(f"message_count: {metadata['message_count']}")

    # Tool counts
    if metadata.get("tool_counts"):
        lines.append("tool_counts:")
        for tool, count in sorted(metadata["tool_counts"].items(), key=lambda x: -x[1]):
            lines.append(f"  {tool}: {count}")

    lines.append("")
    lines.append("messages:")

    # Messages
    for msg in messages:
        lines.append(f"  - index: {msg['index']}")
        lines.append(f"    line: {msg['line']}")
        lines.append(f"    role: {msg['role']}")

        # Handle different message types
        if msg["role"] == "tool_use":
            lines.append(f"    tool: {msg.get('tool', 'unknown')}")
            if "tool_use_id" in msg:
                lines.append(f"    tool_use_id: \"{msg['tool_use_id']}\"")

            # Tool-specific fields
            for key in ["command", "description", "file_path", "pattern", "path",
                       "old_string", "new_string", "content", "subagent_type",
                       "prompt", "url", "query", "input"]:
                if key in msg and msg[key]:
                    value = msg[key]
                    if isinstance(value, dict):
                        lines.append(f"    {key}:")
                        for k, v in value.items():
                            lines.append(f"      {k}: {yaml_value(v)}")
                    elif isinstance(value, str) and ("\n" in value or len(value) > 80):
                        lines.append(f"    {key}: |")
                        for vline in value.split("\n"):
                            lines.append(f"      {vline}")
                    else:
                        lines.append(f"    {key}: {yaml_value(value)}")

        elif msg["role"] == "tool_result":
            if "tool_use_id" in msg:
                lines.append(f"    tool_use_id: \"{msg['tool_use_id']}\"")
            if msg.get("is_error"):
                lines.append(f"    is_error: true")
            if "content" in msg:
                content = msg["content"]
                if "\n" in content or len(content) > 80:
                    lines.append(f"    content: |")
                    for cline in content.split("\n"):
                        lines.append(f"      {cline}")
                else:
                    lines.append(f"    content: {yaml_value(content)}")

        else:
            # User or assistant message
            if msg.get("is_interrupt"):
                lines.append("    is_interrupt: true")

            if "thinking" in msg:
                thinking = msg["thinking"]
                if "\n" in thinking or len(thinking) > 80:
                    lines.append("    thinking: |")
                    for tline in thinking.split("\n"):
                        lines.append(f"      {tline}")
                else:
                    lines.append(f"    thinking: {yaml_value(thinking)}")

            if "content" in msg and msg["content"]:
                content = msg["content"]
                if "\n" in content or len(content) > 80:
                    lines.append("    content: |")
                    for cline in content.split("\n"):
                        lines.append(f"      {cline}")
                else:
                    lines.append(f"    content: {yaml_value(content)}")

        lines.append("")  # Blank line between messages

    return "\n".join(lines)


def yaml_value(value) -> str:
    """Format a value for YAML output."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        # Escape quotes and handle special chars
        if any(c in value for c in ['"', "'", ":", "#", "{", "}", "[", "]", "&", "*", "!", "|", ">", "%", "@", "`"]):
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            return f'"{escaped}"'
        if value == "" or value.startswith(" ") or value.endswith(" "):
            return f'"{value}"'
        return value
    return str(value)


def main():
    parser = argparse.ArgumentParser(
        description="Extract Claude conversation JSONL to YAML with compression tags"
    )
    parser.add_argument(
        "input",
        help="Input JSONL file path"
    )
    parser.add_argument(
        "-o", "--output",
        help="Output YAML file path (default: stdout)"
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Parse and convert
    messages, metadata = parse_jsonl(input_path)
    yaml_output = to_yaml(messages, metadata)

    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(yaml_output)
        print(f"Extracted {len(messages)} messages to {args.output}", file=sys.stderr)
    else:
        print(yaml_output)


if __name__ == "__main__":
    main()
