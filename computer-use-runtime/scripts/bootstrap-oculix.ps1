$ErrorActionPreference = 'Stop'
function Assert-OculixCheckout($Checkout, $Commit) {
  $head = & git -C $Checkout rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $head.Trim() -ne $Commit) { throw 'Oculix checkout differs from the pinned commit' }
  $changes = & git -C $Checkout status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Oculix checkout must be clean, including untracked files; preserve it and use a separate checkout' }
}
function Assert-OculixJdk($Jdk) {
  $java = Join-Path $Jdk 'bin/java.exe'
  if (!(Test-Path -LiteralPath $java)) { throw 'Selected JDK has no java.exe' }
  $version = (& $java -version 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '(?:openjdk|java) version "21(?:\.|\")') { throw 'Oculix bootstrap requires a working JDK 21' }
}
Set-Location (Split-Path $PSScriptRoot -Parent)
$toolsDir = Join-Path (Get-Location) '.tools'
New-Item -ItemType Directory -Force $toolsDir | Out-Null
New-Item -ItemType Directory -Force 'evidence','.research' | Out-Null
$oculixCommit='02ea8844483a83a2963db8016cd7ad421e15bc91'
if (!(Test-Path '.research/Oculix/.git')) {
  git clone --filter=blob:none --no-checkout https://github.com/oculix-org/Oculix.git .research/Oculix
  if ($LASTEXITCODE -ne 0) { throw 'Oculix clone failed' }
  git -C .research/Oculix checkout --detach $oculixCommit
  if ($LASTEXITCODE -ne 0) { throw 'Pinned checkout failed' }
}
Assert-OculixCheckout '.research/Oculix' $oculixCommit
$jdks = @(Get-ChildItem $toolsDir -Directory -Filter 'jdk-*')
if ($jdks.Count -gt 1) { throw 'More than one local JDK is ambiguous; select a separate tools directory' }
$jdk = $jdks | Select-Object -First 1
if (!$jdk) {
  $assets = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
  $asset = $assets[0].binary.package
  if ($asset.size -gt 250000000) { throw 'JDK exceeds the recorded 250 MB bootstrap limit' }
  $archive = Join-Path $toolsDir 'jdk.zip'
  Invoke-WebRequest $asset.link -OutFile $archive
  if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $asset.checksum) { throw 'JDK hash mismatch' }
  $assets[0] | ConvertTo-Json -Depth 12 | Set-Content evidence/jdk-source.json
  Expand-Archive -LiteralPath $archive -DestinationPath $toolsDir -Force
  $jdks = @(Get-ChildItem $toolsDir -Directory -Filter 'jdk-*')
  if ($jdks.Count -ne 1) { throw 'Downloaded JDK layout is missing or ambiguous' }
  $jdk = $jdks[0]
}
Assert-OculixJdk $jdk.FullName
$env:JAVA_HOME = $jdk.FullName
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH
$maven = Join-Path $toolsDir 'apache-maven-3.9.12/bin/mvn.cmd'
if (!(Test-Path $maven)) {
  $archive = Join-Path $toolsDir 'maven.zip'
  Invoke-WebRequest 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.12/apache-maven-3.9.12-bin.zip' -OutFile $archive
  $mavenHash=(Invoke-WebRequest 'https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.12/apache-maven-3.9.12-bin.zip.sha512').Content.Trim().Split(' ')[0]
  if ((Get-FileHash $archive -Algorithm SHA512).Hash.ToLower() -ne $mavenHash.ToLower()) { throw 'Maven hash mismatch' }
  Expand-Archive -LiteralPath $archive -DestinationPath $toolsDir -Force
}
Assert-OculixCheckout '.research/Oculix' $oculixCommit
Assert-OculixJdk $jdk.FullName
& $maven -f .research/Oculix/pom.xml -pl MCP -am -DskipTests -Pmcp-fatjar package *> evidence/oculix-build.log
if ($LASTEXITCODE -ne 0) { throw 'Oculix build failed. See evidence/oculix-build.log.' }
