[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
  [string]$NodeName,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1024, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https?://')]
  [string]$PublicUrl,

  [string]$Image = 'n8nio/n8n:2.25.7',

  [ValidateRange(1, 100)]
  [int]$Concurrency = 20,

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

$composeContent = @'
services:
  n8n:
    image: ${N8N_IMAGE}
    container_name: ews-n8n-${NODE_NAME}
    restart: unless-stopped
    ports:
      - "${N8N_PORT}:5678"
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
    volumes:
      - n8n_data:/home/node/.n8n
      - "${WORKFLOW_DIRECTORY}:/workflows:ro"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:5678/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

volumes:
  n8n_data:
    name: ews_n8n_${NODE_NAME}_data
'@
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
$envLines = @(
  "NODE_NAME=$NodeName"
  "N8N_IMAGE=$Image"
  "N8N_PORT=$Port"
  "N8N_HOST=$($uri.DnsSafeHost)"
  "N8N_PROTOCOL=$($uri.Scheme)"
  "N8N_PUBLIC_URL=$PublicUrl"
  "N8N_ENCRYPTION_KEY=$EncryptionKey"
  "N8N_CONCURRENCY=$Concurrency"
  "N8N_PROXY_HOPS=1"
  "WORKFLOW_DIRECTORY=$workflowMount"
)
[IO.File]::WriteAllLines($envFile, $envLines, (New-Object Text.UTF8Encoding($false)))

$projectName = "ews-n8n-$NodeName"
$composeArgs = @('compose', '--project-name', $projectName, '--env-file', $envFile, '-f', $composeFile)
& docker @composeArgs up -d --pull missing --remove-orphans
if ($LASTEXITCODE -ne 0) { throw 'Failed to start the n8n container' }

$healthy = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $healthy = $true; break }
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
Write-Host "Local health check: http://127.0.0.1:$Port/healthz"
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
