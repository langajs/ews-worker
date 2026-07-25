[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$NodeName,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$PublicUrl,

  [string]$Image = 'n8nio/n8n:stable',

  [ValidateRange(1, 100)]
  [int]$Concurrency = 20,

  [ValidateSet('direct', 'tunnel')]
  [string]$Exposure = 'direct',

  [string]$TunnelToken = '',

  [string]$CloudflaredImage = 'cloudflare/cloudflared:latest',

  [string]$OriginCertPath = '',

  [string]$OriginKeyPath = '',

  [string]$EncryptionKey = '',

  [string]$WorkflowDirectory = '',

  [string]$CredentialsDirectory = '',

  [switch]$ImportWorkflows,

  [switch]$SkipActivation
)

$ErrorActionPreference = 'Stop'
$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $WorkflowDirectory) {
  $WorkflowDirectory = (Resolve-Path (Join-Path $scriptDirectory '..')).Path
} else {
  $WorkflowDirectory = (Resolve-Path $WorkflowDirectory).Path
}

$uri = [Uri]($PublicUrl.TrimEnd('/') + '/')
if ($uri.AbsolutePath -ne '/') {
  throw 'PublicUrl must use a dedicated domain root, for example https://n8n-node2.example.com'
}
$PublicUrl = $PublicUrl.TrimEnd('/') + '/'
$publicPort = if ($uri.IsDefaultPort) { if ($uri.Scheme -eq 'https') { 443 } else { 80 } } else { $uri.Port }
$isLocalPublicUrl = @('localhost', '127.0.0.1', '::1') -contains $uri.DnsSafeHost
if ($Exposure -eq 'tunnel' -and -not $TunnelToken) {
  throw 'TunnelToken is required when Exposure is tunnel. Copy it from Cloudflare Zero Trust > Networks > Tunnels > Add a replica.'
}
if (($OriginCertPath -and -not $OriginKeyPath) -or ($OriginKeyPath -and -not $OriginCertPath)) {
  throw 'OriginCertPath and OriginKeyPath must be provided together.'
}
$useOriginTls = [bool]($OriginCertPath -and $OriginKeyPath)
if ($Exposure -eq 'direct' -and -not $isLocalPublicUrl) {
  $supportedHttpPorts = @(80, 8080, 8880, 2052, 2082, 2086, 2095)
  $supportedHttpsPorts = @(443, 2053, 2083, 2087, 2096, 8443)
  $supportedPorts = if ($uri.Scheme -eq 'https') { $supportedHttpsPorts } else { $supportedHttpPorts }
  if ($supportedPorts -notcontains $publicPort) {
    throw "Cloudflare DNS proxy does not support public $($uri.Scheme.ToUpperInvariant()) port $publicPort for this deployment path."
  }
  if ($Port -ne $publicPort) {
    throw "Direct DNS mode requires Port ($Port) to match the public URL port ($publicPort)."
  }
  if ($uri.Scheme -eq 'https' -and -not $useOriginTls) {
    throw 'Direct HTTPS mode requires OriginCertPath and OriginKeyPath so Cloudflare can use Full (strict) to the origin.'
  }
}
if ($useOriginTls) {
  $OriginCertPath = (Resolve-Path $OriginCertPath).Path
  $OriginKeyPath = (Resolve-Path $OriginKeyPath).Path
}

& docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is unavailable' }
& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose v2 is unavailable' }

$localStateRoot = [Environment]::GetFolderPath('LocalApplicationData')
if (-not $localStateRoot) { $localStateRoot = Join-Path $HOME '.local/state' }
$stateRoot = Join-Path (Join-Path (Join-Path $localStateRoot 'EWS') 'n8n-nodes') $NodeName
$envFile = Join-Path $stateRoot '.env'
$composeFile = Join-Path $stateRoot 'compose.extra-node.yaml'
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

$sslEnvironment = if ($useOriginTls) {
@'
      N8N_SSL_CERT: /certs/origin.pem
      N8N_SSL_KEY: /certs/origin.key
'@
} else { '' }
$sslVolumes = if ($useOriginTls) {
@'
      - "${ORIGIN_CERT_FILE}:/certs/origin.pem:ro"
      - "${ORIGIN_KEY_FILE}:/certs/origin.key:ro"
'@
} else { '' }
$healthScheme = if ($useOriginTls) { 'https' } else { 'http' }
$healthcheckScript = if ($useOriginTls) {
  "process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';fetch('https://127.0.0.1:5678/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
} else {
  "fetch('http://127.0.0.1:5678/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
}
$tunnelService = if ($Exposure -eq 'tunnel') {
@'
  cloudflared:
    image: ${CLOUDFLARED_IMAGE}
    container_name: ews-cloudflared-${NODE_NAME}
    restart: unless-stopped
    depends_on:
      - n8n
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    command: tunnel --no-autoupdate run

'@
} else { '' }

$composeContent = @'
services:
  n8n:
    image: ${N8N_IMAGE}
    container_name: ews-n8n-${NODE_NAME}
    restart: unless-stopped
    ports:
      - "${N8N_BIND_PREFIX}${N8N_PORT}:5678"
    environment:
      N8N_HOST: ${N8N_HOST}
      N8N_PORT: 5678
      N8N_PROTOCOL: ${N8N_PROTOCOL}
      N8N_EDITOR_BASE_URL: ${N8N_PUBLIC_URL}
      WEBHOOK_URL: ${N8N_PUBLIC_URL}
      N8N_PROXY_HOPS: ${N8N_PROXY_HOPS:-1}
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      GENERIC_TIMEZONE: Asia/Shanghai
      TZ: Asia/Shanghai
      NODE_ENV: production
      DB_SQLITE_POOL_SIZE: 2
      N8N_CONCURRENCY_PRODUCTION_LIMIT: ${N8N_CONCURRENCY}
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: 168
      EXECUTIONS_DATA_PRUNE_MAX_COUNT: 10000
      N8N_DIAGNOSTICS_ENABLED: "false"
      N8N_PERSONALIZATION_ENABLED: "false"
      N8N_VERSION_NOTIFICATIONS_ENABLED: "false"
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"
__SSL_ENVIRONMENT__
    volumes:
      - n8n_data:/home/node/.n8n
      - "${WORKFLOW_DIRECTORY}:/workflows:ro"
__SSL_VOLUMES__
    healthcheck:
      test: ["CMD", "node", "-e", "__HEALTHCHECK_SCRIPT__"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

__TUNNEL_SERVICE__
volumes:
  n8n_data:
    name: ews_n8n_${NODE_NAME}_data
'@
$composeContent = $composeContent.Replace('__SSL_ENVIRONMENT__', $sslEnvironment.TrimEnd())
$composeContent = $composeContent.Replace('__SSL_VOLUMES__', $sslVolumes.TrimEnd())
$composeContent = $composeContent.Replace('__HEALTHCHECK_SCRIPT__', $healthcheckScript)
$composeContent = $composeContent.Replace('__TUNNEL_SERVICE__', $tunnelService)
[IO.File]::WriteAllText($composeFile, $composeContent, (New-Object Text.UTF8Encoding($false)))

if ($CredentialsDirectory) {
  $CredentialsDirectory = (Resolve-Path $CredentialsDirectory).Path
  if (-not (Get-ChildItem -LiteralPath $CredentialsDirectory -Filter '*.json' -File | Select-Object -First 1)) {
    throw "No credential JSON files found in $CredentialsDirectory"
  }
}

$importDirectory = Join-Path $stateRoot 'workflows'
$separator = [IO.Path]::DirectorySeparatorChar
$normalizedStateRoot = [IO.Path]::GetFullPath($stateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + $separator
$normalizedImportDirectory = [IO.Path]::GetFullPath($importDirectory)
if (-not $normalizedImportDirectory.StartsWith($normalizedStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved workflow import directory escaped the node state directory'
}
if (Test-Path -LiteralPath $importDirectory) {
  Remove-Item -LiteralPath $importDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $importDirectory -Force | Out-Null
$workflowIds = New-Object Collections.Generic.List[string]
$workflowIndex = 0
foreach ($workflowFile in Get-ChildItem -LiteralPath $WorkflowDirectory -Filter '*.json' -File) {
  $parsed = Get-Content -LiteralPath $workflowFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($workflow in @($parsed)) {
    if (-not $workflow.name -or -not $workflow.nodes -or -not $workflow.id) {
      throw "Invalid n8n workflow JSON: $($workflowFile.Name)"
    }
    $workflowIndex++
    $workflowIds.Add([string]$workflow.id)
    $target = Join-Path $importDirectory ('workflow-{0:d2}.json' -f $workflowIndex)
    $json = $workflow | ConvertTo-Json -Depth 100 -Compress
    [IO.File]::WriteAllText($target, $json, (New-Object Text.UTF8Encoding($false)))
  }
}
if ($workflowIds.Count -eq 0) { throw "No n8n workflow JSON files found in $WorkflowDirectory" }

$existing = @{}
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding utf8) {
    if ($line -match '^([^#=]+)=(.*)$') { $existing[$matches[1]] = $matches[2] }
  }
}
if (-not $EncryptionKey) { $EncryptionKey = $existing['N8N_ENCRYPTION_KEY'] }
if (-not $EncryptionKey) {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  $EncryptionKey = -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
if ($EncryptionKey.Length -lt 32) { throw 'EncryptionKey must contain at least 32 characters' }

$workflowMount = $importDirectory.Replace('\', '/')
$bindPrefix = if ($Exposure -eq 'tunnel') { '127.0.0.1:' } else { '' }
$envLines = @(
  "NODE_NAME=$NodeName"
  "N8N_IMAGE=$Image"
  "CLOUDFLARED_IMAGE=$CloudflaredImage"
  "N8N_PORT=$Port"
  "N8N_BIND_PREFIX=$bindPrefix"
  "N8N_HOST=$($uri.DnsSafeHost)"
  "N8N_PROTOCOL=$($uri.Scheme)"
  "N8N_PUBLIC_URL=$PublicUrl"
  "N8N_ENCRYPTION_KEY=$EncryptionKey"
  "N8N_CONCURRENCY=$Concurrency"
  "N8N_PROXY_HOPS=1"
  "WORKFLOW_DIRECTORY=$workflowMount"
)
if ($Exposure -eq 'tunnel') {
  $envLines += "CLOUDFLARE_TUNNEL_TOKEN=$TunnelToken"
}
if ($useOriginTls) {
  $envLines += "ORIGIN_CERT_FILE=$($OriginCertPath.Replace('\', '/'))"
  $envLines += "ORIGIN_KEY_FILE=$($OriginKeyPath.Replace('\', '/'))"
}
[IO.File]::WriteAllLines($envFile, $envLines, (New-Object Text.UTF8Encoding($false)))

$projectName = "ews-n8n-$NodeName"
$composeArgs = @('compose', '--project-name', $projectName, '--env-file', $envFile, '-f', $composeFile)
& docker @composeArgs up -d --pull missing --remove-orphans
if ($LASTEXITCODE -ne 0) { throw 'Failed to start the n8n container' }

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    if ($useOriginTls) {
      & curl.exe -k -fsS "${healthScheme}://127.0.0.1:$Port/healthz" | Out-Null
      if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    } else {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "${healthScheme}://127.0.0.1:$Port/healthz" -TimeoutSec 3
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    }
  } catch {}
  Start-Sleep -Seconds 2
}
if (-not $healthy) { throw "n8n did not become healthy within 120 seconds. Run: docker logs ews-n8n-$NodeName" }

if ($ImportWorkflows) {
  if ($CredentialsDirectory) {
    $containerName = "ews-n8n-$NodeName"
    & docker cp "$CredentialsDirectory/." "${containerName}:/tmp/ews-credentials"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to copy the credential migration directory into n8n' }
    try {
      & docker @composeArgs exec -T n8n n8n import:credentials --separate --input=/tmp/ews-credentials
      if ($LASTEXITCODE -ne 0) { throw 'Credential import failed' }
    } finally {
      & docker @composeArgs exec -T n8n node -e "require('fs').rmSync('/tmp/ews-credentials',{recursive:true,force:true})"
    }
  }
  & docker @composeArgs exec -T n8n n8n import:workflow --separate --input=/workflows
  if ($LASTEXITCODE -ne 0) { throw 'Workflow import failed. Initialize the n8n owner account, then rerun with -ImportWorkflows' }
  if (-not $SkipActivation) {
    foreach ($workflowId in $workflowIds) {
      & docker @composeArgs exec -T n8n n8n publish:workflow --id=$workflowId
      if ($LASTEXITCODE -ne 0) { throw "Workflow $workflowId was imported but could not be published" }
    }
    & docker @composeArgs restart n8n
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restart n8n after workflow activation' }
  }
}

Write-Host "n8n node is ready: $PublicUrl"
Write-Host "Exposure mode: $Exposure"
Write-Host "Local health check: ${healthScheme}://127.0.0.1:$Port/healthz"
Write-Host "Node state directory: $stateRoot"
if (-not $ImportWorkflows) {
  Write-Host 'Initialize the owner account, then rerun with the same parameters and -ImportWorkflows.'
}
if ($CredentialsDirectory) {
  Write-Host 'Credentials were imported. Securely delete the decrypted host credential directory after validation.'
}
Write-Host "Imported workflow definitions: $($workflowIds.Count)"
Write-Host 'Per-user webhook prefixes (see README.md for the complete mapping):'
Write-Host "  $($PublicUrl)webhook/vn/..."
Write-Host "  $($PublicUrl)webhook/cn/..."
