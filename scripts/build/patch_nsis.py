#!/usr/bin/env python3
"""Patch the custom Tauri NSIS template to embed all app resources explicitly.

Tauri v2's resource bundler on Windows inconsistently drops gitignored/large
resources (nodejs, server-dist.js, etc.). This script embeds
a macro with absolute File /r commands into src-tauri/nsis/installer.nsi so the
NSIS installer itself copies every required resource, bypassing Tauri's walker.
"""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project_dir", help="Absolute project root path")
    args = parser.parse_args()

    project_dir = os.path.abspath(args.project_dir)
    nsis_dir = os.path.join(project_dir, "src-tauri", "nsis")
    nsi_path = os.path.join(nsis_dir, "installer.nsi")

    if not os.path.isfile(nsi_path):
        print(f"ERROR: {nsi_path} not found", file=sys.stderr)
        sys.exit(1)

    with open(nsi_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Remove any previously injected macro and call/uninstall deletes
    start_marker = "\n; Extra resources added explicitly to bypass Tauri resource bundling issues"
    idx = content.find(start_marker)
    if idx != -1:
        end = content.find("!macroend\n", idx)
        if end != -1:
            content = content[:idx] + content[end + len("!macroend\n"):]

    content = content.replace(
        "\n\n  ; Extra resources\n  !insertmacro _ZHISHI_EXTRA_RESOURCES", ""
    )

    uninstall_start = "\n\n  ; Delete extra resources"
    idx = content.find(uninstall_start)
    if idx != -1:
        # Remove until the next double-newline followed by a comment or section
        next_block = content.find("\n\n  ;", idx + 1)
        if next_block == -1:
            next_block = content.find("\n\n  ; Delete external binaries", idx + 1)
        if next_block == -1:
            next_block = len(content)
        content = content[:idx] + content[next_block:]

    # Build macro with absolute paths
    r = project_dir.replace("/", "\\")
    macro = f'''
; Extra resources added explicitly to bypass Tauri resource bundling issues
!macro _ZHISHI_EXTRA_RESOURCES
  ; server-dist.js
  SetOutPath "$INSTDIR"
  File /nonfatal "{r}\\src-tauri\\resources\\server-dist.js"
  ; sharp-runtime
  SetOutPath "$INSTDIR\\sharp-runtime"
  File /nonfatal /r "{r}\\src-tauri\\resources\\sharp-runtime\\*.*"
  ; sqlite-runtime（记忆库引擎，better-sqlite3 内置 Node ABI）
  SetOutPath "$INSTDIR\\sqlite-runtime"
  File /nonfatal /r "{r}\\src-tauri\\resources\\sqlite-runtime\\*.*"
  ; pty-runtime（attach 交互终端，@lydell/node-pty N-API 预编译件）
  SetOutPath "$INSTDIR\\pty-runtime"
  File /nonfatal /r "{r}\\src-tauri\\resources\\pty-runtime\\*.*"
  ; tsx-runtime
  SetOutPath "$INSTDIR\\tsx-runtime"
  File /nonfatal /r "{r}\\src-tauri\\resources\\tsx-runtime\\*.*"
  ; nodejs
  SetOutPath "$INSTDIR\\nodejs"
  File /nonfatal /r "{r}\\src-tauri\\resources\\nodejs\\*.*"
  ; shared
  SetOutPath "$INSTDIR\\shared"
  File /nonfatal /r "{r}\\src\\shared\\*.*"
  ; bundled-skills
  SetOutPath "$INSTDIR\\bundled-skills"
  File /nonfatal /r "{r}\\bundled-skills\\*.*"
  ; cli
  SetOutPath "$INSTDIR\\cli"
  File /nonfatal /r "{r}\\src-tauri\\resources\\cli\\*.*"
  ; en.lproj
  SetOutPath "$INSTDIR\\en.lproj"
  File /nonfatal "{r}\\src-tauri\\infoplist\\en.lproj\\InfoPlist.strings"
  ; zh-Hans.lproj
  SetOutPath "$INSTDIR\\zh-Hans.lproj"
  File /nonfatal "{r}\\src-tauri\\infoplist\\zh-Hans.lproj\\InfoPlist.strings"
  ; VC++ runtime
  SetOutPath "$INSTDIR"
  File /nonfatal "{r}\\src-tauri\\resources\\vcruntime140.dll"
  File /nonfatal "{r}\\src-tauri\\resources\\vcruntime140_1.dll"
!macroend
'''

    hook_block = '{{#if installer_hooks}}\n!include "{{installer_hooks}}"\n{{/if}}'
    if hook_block in content:
        content = content.replace(hook_block, hook_block + macro)
    else:
        content = macro + content

    res_loop_patterns = [
        '{{#each resources}}\n\n    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"\n\n  {{/each}}',
        '{{#each resources}}\n    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"\n  {{/each}}',
    ]
    found = False
    for p in res_loop_patterns:
        if p in content:
            content = content.replace(
                p, p + '\n\n  ; Extra resources\n  !insertmacro _ZHISHI_EXTRA_RESOURCES'
            )
            found = True
            break
    if not found:
        print("ERROR: resources loop not found in installer.nsi", file=sys.stderr)
        sys.exit(1)

    uninstall_loop = '{{#each resources}}\n\n    Delete "$INSTDIR\\\\{{this.[1]}}"\n\n  {{/each}}'
    if uninstall_loop in content:
        delete_extra = '''\n\n  ; Delete extra resources
  Delete "$INSTDIR\\server-dist.js"
  Delete "$INSTDIR\\vcruntime140.dll"
  Delete "$INSTDIR\\vcruntime140_1.dll"
  RMDir /r "$INSTDIR\\sharp-runtime"
  RMDir /r "$INSTDIR\\sqlite-runtime"
  RMDir /r "$INSTDIR\\pty-runtime"
  RMDir /r "$INSTDIR\\tsx-runtime"
  RMDir /r "$INSTDIR\\nodejs"
  RMDir /r "$INSTDIR\\shared"
  RMDir /r "$INSTDIR\\bundled-skills"
  RMDir /r "$INSTDIR\\cli"
  RMDir "$INSTDIR\\en.lproj"
  RMDir "$INSTDIR\\zh-Hans.lproj"'''
        content = content.replace(uninstall_loop, uninstall_loop + delete_extra)
    else:
        print("ERROR: uninstall resources loop not found", file=sys.stderr)
        sys.exit(1)

    # Fix Git installer path to absolute path (works for any build dir depth)
    git_abs = f'{r}\\src-tauri\\nsis\\Git-Installer.exe'
    content = content.replace('"../../../../../nsis\\Git-Installer.exe"', f'"{git_abs}"')
    # Also fix the default-target variant if present
    content = content.replace('"../../../../nsis\\Git-Installer.exe"', f'"{git_abs}"')
    # The bundled Git installer may also use a bare relative filename
    content = content.replace(
        'File /nonfatal "/oname=$TEMP\\Git-Installer.exe" "Git-Installer.exe"',
        f'File /nonfatal "/oname=$TEMP\\Git-Installer.exe" "{git_abs}"'
    )

    with open(nsi_path, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"Patched {nsi_path}")


if __name__ == "__main__":
    main()
