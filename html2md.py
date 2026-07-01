#!/usr/bin/env python3
"""Regenerate conduitspec.md from the <main> content of conduitspec.html.

HTML is the source of truth; this derives the Markdown copy so the two stay
text-identical. Zero dependencies — standard library only (html.parser).

Usage:
    python3 html2md.py                      # html -> md, default filenames
    python3 html2md.py in.html out.md       # explicit paths
"""
import sys
import re
from html.parser import HTMLParser
from html import unescape

# Tags handled as block-level structure; everything else is treated as inline.
BLOCK = {"h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "blockquote",
         "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "hr"}


class MainExtractor(HTMLParser):
    """Capture the raw inner HTML of the first <main> element."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.depth = 0
        self.capturing = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "main" and not self.capturing:
            self.capturing = True
            self.depth = 0
            return
        if self.capturing:
            self.depth += 1
            a = "".join(f' {k}="{v}"' for k, v in attrs)
            self.parts.append(f"<{tag}{a}>")

    def handle_startendtag(self, tag, attrs):
        if self.capturing:
            a = "".join(f' {k}="{v}"' for k, v in attrs)
            self.parts.append(f"<{tag}{a}/>")

    def handle_endtag(self, tag):
        if tag == "main" and self.capturing and self.depth == 0:
            self.capturing = False
            return
        if self.capturing:
            self.depth -= 1
            self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        if self.capturing:
            self.parts.append(data)

    def handle_entityref(self, name):
        if self.capturing:
            self.parts.append(f"&{name};")

    def handle_charref(self, name):
        if self.capturing:
            self.parts.append(f"&#{name};")

    def raw(self):
        return "".join(self.parts)


def inline_to_md(html_fragment: str) -> str:
    """Convert an inline HTML fragment to Markdown text."""
    s = html_fragment
    s = re.sub(r"<strong>(.*?)</strong>", r"**\1**", s, flags=re.S)
    s = re.sub(r"<b>(.*?)</b>", r"**\1**", s, flags=re.S)
    s = re.sub(r"<em>(.*?)</em>", r"*\1*", s, flags=re.S)
    s = re.sub(r"<i>(.*?)</i>", r"*\1*", s, flags=re.S)
    s = re.sub(r"<code>(.*?)</code>", r"`\1`", s, flags=re.S)
    s = re.sub(r'<a [^>]*href="([^"]*)"[^>]*>(.*?)</a>', r"[\2](\1)", s, flags=re.S)
    s = re.sub(r"<br\s*/?>", "  \n", s)
    s = re.sub(r"<[^>]+>", "", s)            # drop any leftover tags
    s = unescape(s)
    return s


def _code_lang(pre_block: str) -> str:
    m = re.search(r'class="language-([a-z0-9]+)"', pre_block)
    return m.group(1) if m else ""


def convert(main_html: str) -> str:
    out = []
    # Split into top-level blocks by walking balanced tags would be ideal, but the
    # source is generated and flat enough to handle block-by-block with a tokenizer.
    pos = 0
    # Master pattern: each known block element, non-greedy, with its matching close.
    block_re = re.compile(
        r"<(h1|h2|h3|h4|p|blockquote)\b[^>]*>(.*?)</\1>"
        r"|<pre>(.*?)</pre>"
        r"|<(ul|ol)>(.*?)</\4>"
        r"|<table>(.*?)</table>"
        r"|<hr\s*/?>",
        re.S,
    )

    for m in block_re.finditer(main_html):
        if m.group(1):  # heading or paragraph or blockquote
            tag, inner = m.group(1), m.group(2)
            text = inline_to_md(inner).strip()
            if tag == "h1":
                out.append(f"# {text}")
            elif tag == "h2":
                out.append(f"## {text}")
            elif tag == "h3":
                out.append(f"### {text}")
            elif tag == "h4":
                out.append(f"#### {text}")
            elif tag == "p":
                out.append(text)
            elif tag == "blockquote":
                # blockquote may itself wrap <p> elements
                paras = re.findall(r"<p>(.*?)</p>", inner, re.S) or [inner]
                quoted = "\n".join("> " + inline_to_md(p).strip().replace("\n", "\n> ")
                                   for p in paras)
                out.append(quoted)

        elif m.group(3) is not None:  # <pre> code block
            pre = m.group(0)
            lang = _code_lang(pre)
            code_inner = re.search(r"<code[^>]*>(.*?)</code>", m.group(3), re.S)
            body = code_inner.group(1) if code_inner else m.group(3)
            body = unescape(re.sub(r"<[^>]+>", "", body))
            body = body.strip("\n")
            out.append(f"```{lang}\n{body}\n```")

        elif m.group(4):  # list
            kind, inner = m.group(4), m.group(5)
            items = re.findall(r"<li>(.*?)</li>", inner, re.S)
            lines = []
            for i, it in enumerate(items, 1):
                # A list item may contain a nested <pre>; keep it inline-indented.
                pre_m = re.search(r"<pre>.*?</pre>", it, re.S)
                pre_text = ""
                if pre_m:
                    lang = _code_lang(pre_m.group(0))
                    cm = re.search(r"<code[^>]*>(.*?)</code>", pre_m.group(0), re.S)
                    cb = unescape(re.sub(r"<[^>]+>", "", cm.group(1) if cm else ""))
                    pre_text = f"\n```{lang}\n{cb.strip(chr(10))}\n```"
                    it = it[:pre_m.start()] + it[pre_m.end():]
                text = inline_to_md(it).strip()
                marker = f"{i}." if kind == "ol" else "-"
                lines.append(f"{marker} {text}{pre_text}")
            out.append("\n".join(lines))

        elif m.group(6) is not None:  # table
            tbl = m.group(6)
            headers = re.findall(r"<th[^>]*>(.*?)</th>", tbl, re.S)
            rows = re.findall(r"<tr>(.*?)</tr>", tbl, re.S)
            lines = []
            if headers:
                lines.append("| " + " | ".join(inline_to_md(h).strip() for h in headers) + " |")
                lines.append("| " + " | ".join("---" for _ in headers) + " |")
            for r in rows:
                cells = re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)
                if cells:
                    lines.append("| " + " | ".join(inline_to_md(c).strip() for c in cells) + " |")
            out.append("\n".join(lines))

        else:  # <hr>
            out.append("---")

    return "\n\n".join(out).rstrip() + "\n"


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "conduitspec.html"
    dst = sys.argv[2] if len(sys.argv) > 2 else "conduitspec.md"

    html_text = open(src, encoding="utf-8").read()
    ex = MainExtractor()
    ex.feed(html_text)
    main_html = ex.raw()
    if not main_html.strip():
        sys.exit(f"[html2md] No <main> content found in {src}")

    md = convert(main_html)
    open(dst, "w", encoding="utf-8").write(md)
    print(f"[html2md] Wrote {dst} ({len(md)} bytes) from {src}")


if __name__ == "__main__":
    main()
