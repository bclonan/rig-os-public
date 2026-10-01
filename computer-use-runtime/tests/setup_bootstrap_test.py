"""Execute extracted PowerShell guards with owned Git fixtures and stub tools."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

root = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == 'nt', 'Windows PowerShell setup/bootstrap paths')
class SetupBootstrapTests(unittest.TestCase):
    def ps(self, script):
        with tempfile.TemporaryDirectory(prefix='cur-setup-guards-') as directory:
            path = Path(directory) / 'guards.ps1'
            path.write_text(script, encoding='utf-8')
            return subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(path)], capture_output=True, timeout=20)

    def test_existing_venv_ignores_null_and_stale_creation_exit_codes(self):
        source = (root / 'scripts/setup-training.ps1').read_text()
        # Only external tool calls and cwd are replaced. The actual branch and
        # both exit guards execute unchanged, with counters proving which ran.
        body = source.replace('Set-Location (Split-Path $PSScriptRoot -Parent)', '')
        body = body.replace('& .venv/Scripts/python.exe', 'Invoke-OwnedPip')
        for exists, initial, creation, pip in [(True, '$null', 0, 0), (True, '19', 0, 0), (False, '$null', 0, 0), (False, '$null', 7, 0), (True, '$null', 0, 9)]:
            with self.subTest(exists=exists, initial=initial, creation=creation, pip=pip):
                stubs = f"""
$global:LASTEXITCODE={initial}; $global:created=0; $global:installed=0
function Test-Path {{ return ${str(exists).lower()} }}
function python {{ $global:created++; $global:LASTEXITCODE={creation} }}
function Invoke-OwnedPip {{ $global:installed++; $global:LASTEXITCODE={pip} }}
"""
                expected = bool(creation and not exists or pip)
                script = stubs + '\ntry {\n' + body + '\nif (' + ('$true' if expected else '$false') + ') { throw "Expected dependency refusal" }\n} catch {\n'
                if not expected:
                    script += 'throw\n'
                else:
                    script += 'if ($_.Exception.Message -notmatch "creation failed|installation failed") { throw }\n'
                script += f'}}\nif ($global:created -ne {0 if exists else 1}) {{ throw "Unexpected venv creation" }}\n'
                script += f'if ($global:installed -ne {0 if creation and not exists else 1}) {{ throw "Unexpected pip invocation" }}\n'
                result = self.ps(script)
                self.assertEqual(result.returncode, 0, result.stdout.decode(errors='replace') + result.stderr.decode(errors='replace'))

    def test_pinned_clean_git_checkout_required(self):
        with tempfile.TemporaryDirectory(prefix='cur-owned-bootstrap-git-') as directory:
            checkout = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', directory, *args], capture_output=True, check=True).stdout.decode().strip()
            git('init', '-q')
            (checkout / 'tracked.txt').write_text('pinned')
            git('add', 'tracked.txt')
            git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'owned fixture')
            pinned = git('rev-parse', 'HEAD')
            prefix = f"$ErrorActionPreference='Stop'; $source='{(root / 'scripts/bootstrap-oculix.ps1').as_posix()}'; $ast=[System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$null,[ref]$null); $function=$ast.Find({{param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-OculixCheckout'}},$true); Invoke-Expression $function.Extent.Text; "
            for variant in ('clean', 'wrong-head', 'modified', 'untracked'):
                with self.subTest(variant=variant):
                    if variant == 'modified': (checkout / 'tracked.txt').write_text('changed')
                    if variant == 'untracked':
                        (checkout / 'tracked.txt').write_text('pinned')
                        (checkout / 'untracked.txt').write_text('untrusted build input')
                    commit = '0' * 40 if variant == 'wrong-head' else pinned
                    call = f"Assert-OculixCheckout '{checkout.as_posix()}' '{commit}'"
                    script = prefix + (call if variant == 'clean' else f'try {{ {call}; throw "Expected refusal" }} catch {{ if ($_.Exception.Message -notmatch "differs|must be clean") {{ throw }} }}')
                    result = self.ps(script)
                    self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))

    def test_jdk_version_guard_rejects_wrong_and_failed_java(self):
        # Extract the exact version predicate and surrounding throw, after the
        # external java command. No JDK/Maven/network command executes here.
        source = (root / 'scripts/bootstrap-oculix.ps1').read_text()
        guard = next(line for line in source.splitlines() if '$version -notmatch' in line)
        for version, code, accepted in [('openjdk version "21.0.6"', 0, True), ('java version "21"', 0, True), ('openjdk version "17.0.14"', 0, False), ('openjdk version "210.0"', 0, False), ('openjdk version "21.0.6"', 1, False), ('', 0, False)]:
            with self.subTest(version=version, code=code):
                script = f"$ErrorActionPreference='Stop'; $LASTEXITCODE={code}; $version='{version}'; "
                script += guard if accepted else f'try {{ {guard}; throw "Expected JDK refusal" }} catch {{ if ($_.Exception.Message -notmatch "JDK 21") {{ throw }} }}'
                result = self.ps(script)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace'))


if __name__ == '__main__':
    unittest.main()
