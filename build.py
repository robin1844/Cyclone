"""Build the dependency-free, single-document app from its section sources."""
from pathlib import Path
import hashlib
import re

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"


def scope_css(css, name):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    result = []
    while css.strip():
        start = css.index("{")
        header = css[:start].strip()
        depth, end = 1, start + 1
        while depth:
            if css[end] == "{":
                depth += 1
            elif css[end] == "}":
                depth -= 1
            end += 1
        body = css[start + 1:end - 1]
        if header.startswith("@"):
            body = scope_css(body, name)
        else:
            selectors = []
            for selector in header.split(","):
                selector = selector.strip()
                selector = re.sub(r"#([\w-]+)", rf"#{name}-\1", selector)
                if selector in (":root", "body", "html"):
                    selector = f"#{name}-section"
                else:
                    selector = f"#{name}-section {selector}"
                selectors.append(selector)
            header = ", ".join(selectors)
        result.append(f"{header} {{{body}}}")
        css = css[end:]
    return "\n".join(result)


def build():
    launcher = (SRC / "launcher.html").read_text(encoding="utf-8")
    css = re.search(r"<style>(.*?)</style>", launcher, re.S)[1]
    # Launcher rules must not leak into the embedded workout sections.
    css = css.replace("  button", "  #launcher button")
    css += "\n[hidden] { display: none !important; }\n.workout-section { min-height: 100vh; }\n"
    markup = re.search(r'<div id="launcher">.*?</div>', launcher, re.S)[0]
    for name in ("cyclone", "typhoon", "mistral"):
        markup = markup.replace(f'onclick="location.href=\'{name}/\'"', f'id="open-{name}" data-section="{name}"')
    scripts = [(SRC / "shell.js").read_text(encoding="utf-8")]
    for name in ("cyclone", "typhoon", "mistral"):
        source = (SRC / f"{name}.html").read_text(encoding="utf-8")
        css += "\n" + scope_css(re.search(r"<style>(.*?)</style>", source, re.S)[1], name)
        body = re.search(r"<body>(.*?)<script>", source, re.S)[1].strip()
        ids = re.findall(r'\bid="([^"]+)"', body)
        body = re.sub(r'\bid="([^"]+)"', rf'id="{name}-\1"', body)
        for attribute in ("for", "aria-labelledby", "aria-describedby", "aria-controls"):
            body = re.sub(rf'{attribute}="([^"]+)"', lambda m: f'{attribute}="' + " ".join(f"{name}-{x}" if x in ids else x for x in m[1].split()) + '"', body)
        markup += f'\n<div id="{name}-section" class="workout-section" hidden>\n{body}\n</div>\n'
        script = re.search(r"<script>(.*?)</script>", source, re.S)[1]
        if name == "typhoon":
            script = script.replace('file: "audio/', 'file: "typhoon/audio/')
        script = re.sub(r'^\s*"use strict";', "", script)
        scripts.append(f'\n// {name.title()} workout engine\n(() => {{\nconst document = sectionDocument("{name}");\n{script}\n}})();')
    scripts.append('''
document.querySelectorAll("[data-section]").forEach(button => {
  button.addEventListener("click", () => showSection(button.dataset.section));
});
window.addEventListener("popstate", () => showSection(location.hash.slice(1), false));
showSection(location.hash.slice(1), false);
Bike.autoConnect();
''')
    js = "\n".join(scripts)
    version = hashlib.sha256((css + js).encode()).hexdigest()[:12]
    (ROOT / "app.css").write_text(css, encoding="utf-8")
    (ROOT / "app.js").write_text(js, encoding="utf-8")
    page = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Cyclone</title>
<link rel="stylesheet" href="app.css?v={version}" />
</head>
<body>
{markup}
<script src="app.js?v={version}"></script>
</body>
</html>
'''
    (ROOT / "index.html").write_text(page, encoding="utf-8")
    for name in ("cyclone", "typhoon", "mistral"):
        (ROOT / name / "index.html").write_text(f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{name.title()}</title>
<meta http-equiv="refresh" content="0;url=../#{name}" />
<script>location.replace("../#{name}");</script>
</head><body><a href="../#{name}">Open {name.title()}</a></body></html>
''', encoding="utf-8")


if __name__ == "__main__":
    build()
