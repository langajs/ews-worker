[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$N8nImage = 'n8nio/n8n:2.25.7'

function Decode-Value([string]$Value) {
  if (-not $Value -or $Value.StartsWith('__EWS_')) {
    throw 'Installer parameters are incomplete. Generate this script from the EWS admin deployment page.'
  }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Wait-N8n([int]$Port, [int]$Attempts = 60) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "n8n did not become healthy within $($Attempts * 2) seconds."
}

function Get-N8nSettings([int]$Port, [int]$Attempts = 30) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      $response = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/rest/settings" -TimeoutSec 5
      $setupFlag = $response.data.userManagement.showSetupOnFirstLoad
      if ($null -ne $setupFlag) { return $response }
    } catch {}
    Start-Sleep -Seconds 2
  }
  throw "n8n management API did not become ready within $($Attempts * 2) seconds."
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

$NodeName = Decode-Value $env:EWS_NODE_NAME_B64
$Domain = Decode-Value $env:EWS_DOMAIN_B64
$OwnerEmail = Decode-Value $env:EWS_OWNER_EMAIL_B64
$OwnerPassword = Decode-Value $env:EWS_OWNER_PASSWORD_B64
$GrsaiKey = (Decode-Value $env:EWS_GRSAI_KEY_B64).Trim()
$DeepseekKey = (Decode-Value $env:EWS_DEEPSEEK_KEY_B64).Trim()
$BackupKey = (Decode-Value $env:EWS_BACKUP_KEY_B64).Trim()
$ImageServiceInput = (Decode-Value $env:EWS_IMAGE_SERVICE_URL_B64).Trim()
$WorkflowBundleJson = Decode-Value '__EWS_WORKFLOW_BUNDLE_B64__'
$Port = [int]$env:EWS_PORT

if ($NodeName -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { throw 'Node name must contain only lowercase letters, numbers, and hyphens.' }
if ($Domain -notmatch '^[A-Za-z0-9.-]+$' -or $Domain.Contains('..')) { throw 'Public domain is invalid.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
if ($OwnerEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'n8n owner email is invalid.' }
if ($OwnerPassword.Length -lt 8 -or $OwnerPassword.Length -gt 64) { throw 'n8n owner password must contain 8 to 64 characters.' }
if ($OwnerPassword -notmatch '[A-Z]') { throw 'n8n owner password must contain at least one uppercase letter.' }
if ($OwnerPassword -notmatch '\d') { throw 'n8n owner password must contain at least one number.' }
if (-not $GrsaiKey -or -not $DeepseekKey -or -not $BackupKey) { throw 'All three model API keys are required.' }

try {
  $imageUri = [Uri]$ImageServiceInput
} catch {
  throw 'Image service URL is invalid.'
}
if ($imageUri.Scheme -notin @('http', 'https')) { throw 'Image service URL must use HTTP or HTTPS.' }
$ImageServiceUrl = $ImageServiceInput.TrimEnd('/')
if ($ImageServiceUrl.EndsWith('/v1/image-jobs')) {
  $ImageServiceBaseUrl = $ImageServiceUrl.Substring(0, $ImageServiceUrl.Length - '/v1/image-jobs'.Length)
  $ImageJobUrl = $ImageServiceUrl
} else {
  $ImageServiceBaseUrl = $ImageServiceUrl
  $ImageJobUrl = "$ImageServiceUrl/v1/image-jobs"
}
$ImageDockerNetwork = ''
try {
  $candidateNetwork = & docker inspect $imageUri.Host --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{println}}{{end}}' 2>$null | Select-Object -First 1
  if ($candidateNetwork) { $ImageDockerNetwork = ([string]$candidateNetwork).Trim() }
} catch {}

& docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running.' }
if ($imageUri.Host -eq 'ews-image-sidecar' -and -not $ImageDockerNetwork) {
  throw 'Local image service container ews-image-sidecar was not found. Start the image service on this host or enter its external HTTPS endpoint in the Wiki.'
}

$StateRoot = Join-Path (Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EWS') 'n8n-nodes') $NodeName
$WorkflowDirectory = Join-Path $StateRoot 'workflows'
$CredentialDirectory = Join-Path $StateRoot 'credentials-import'
$EncryptionKeyFile = Join-Path $StateRoot 'encryption.key'
$EnvFile = Join-Path $StateRoot 'n8n.env'
$ContainerName = "ews-n8n-$NodeName"
$NetworkName = "ews-$NodeName"
$VolumeName = "ews_n8n_$($NodeName)_data"

New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $EncryptionKeyFile) -or -not (Get-Content -LiteralPath $EncryptionKeyFile -Raw).Trim()) {
  $generatedKey = & docker run --rm --entrypoint node $N8nImage -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
  if ($LASTEXITCODE -ne 0 -or -not $generatedKey) { throw 'Failed to generate the n8n encryption key.' }
  Write-Utf8NoBom $EncryptionKeyFile $generatedKey.Trim()
}
$EncryptionKey = (Get-Content -LiteralPath $EncryptionKeyFile -Raw).Trim()
if ($EncryptionKey.Length -lt 32) { throw 'The persisted n8n encryption key is invalid.' }

$PublicUrl = "https://$Domain/"
$envLines = @(
  "N8N_HOST=$Domain"
  'N8N_PORT=5678'
  'N8N_PROTOCOL=https'
  "N8N_EDITOR_BASE_URL=$PublicUrl"
  "WEBHOOK_URL=$PublicUrl"
  'N8N_PROXY_HOPS=1'
  "N8N_ENCRYPTION_KEY=$EncryptionKey"
  'GENERIC_TIMEZONE=Asia/Shanghai'
  'TZ=Asia/Shanghai'
  'NODE_ENV=production'
  'DB_SQLITE_POOL_SIZE=2'
  'N8N_CONCURRENCY_PRODUCTION_LIMIT=20'
  'EXECUTIONS_DATA_PRUNE=true'
  'EXECUTIONS_DATA_MAX_AGE=168'
  'EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000'
  'N8N_DIAGNOSTICS_ENABLED=false'
  'N8N_PERSONALIZATION_ENABLED=false'
  'N8N_VERSION_NOTIFICATIONS_ENABLED=false'
  'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true'
)
[IO.File]::WriteAllLines($EnvFile, $envLines, (New-Object Text.UTF8Encoding($false)))

$normalizedStateRoot = [IO.Path]::GetFullPath($StateRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
foreach ($directory in @($WorkflowDirectory, $CredentialDirectory)) {
  $normalizedDirectory = [IO.Path]::GetFullPath($directory)
  if (-not $normalizedDirectory.StartsWith($normalizedStateRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer working directory escaped the node state directory.'
  }
  if (Test-Path -LiteralPath $directory) { [IO.Directory]::Delete($directory, $true) }
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$workflowEntries = $WorkflowBundleJson | ConvertFrom-Json
$workflowIds = New-Object Collections.Generic.List[string]
$imageWorkflowCount = 0
$workflowIndex = 0
foreach ($entry in $workflowEntries) {
  $workflowIndex++
  $workflow = [string]$entry.content
  if (-not $entry.id -or -not $workflow) { throw "Workflow bundle entry $workflowIndex is invalid." }
  $workflowIds.Add([string]$entry.id)
  if ($workflow.Contains('http://ews-image-sidecar:3000/v1/image-jobs')) {
    $workflow = $workflow.Replace('http://ews-image-sidecar:3000/v1/image-jobs', $ImageJobUrl)
    $imageWorkflowCount++
  }
  Write-Utf8NoBom (Join-Path $WorkflowDirectory ('workflow-{0:d2}.json' -f $workflowIndex)) $workflow
}
if ($workflowIds.Count -ne 9) { throw "Expected 9 workflows, found $($workflowIds.Count)." }
if ($imageWorkflowCount -ne 7) { throw "Expected 7 image workflows, rewrote $imageWorkflowCount." }

$credentials = @(
  @{ id = 'Ua1TBIbDcAu3z8pU'; name = 'GrsaiApp'; type = 'httpHeaderAuth'; data = @{ name = 'Authorization'; value = "Bearer $GrsaiKey" } }
  @{ id = '11xE3AjgQ1iUHDdR'; name = 'deepseek'; type = 'httpHeaderAuth'; data = @{ name = 'Authorization'; value = "Bearer $DeepseekKey" } }
  @{ id = 'bkpImgApi20260722'; name = 'EWS Backup Image API'; type = 'httpHeaderAuth'; data = @{ name = 'Authorization'; value = "Bearer $BackupKey" } }
)
$credentialIndex = 0
foreach ($credential in $credentials) {
  $credentialIndex++
  $credentialJson = ConvertTo-Json -InputObject @($credential) -Depth 10 -Compress
  Write-Utf8NoBom (Join-Path $CredentialDirectory ('credential-{0:d2}.json' -f $credentialIndex)) $credentialJson
}
$GrsaiKey = $null
$DeepseekKey = $null
$BackupKey = $null

$networkExists = & docker network ls --filter "name=^$NetworkName`$" --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect Docker networks.' }
if (-not ($networkExists -contains $NetworkName)) {
  & docker network create $NetworkName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Docker network.' }
}
$volumeExists = & docker volume ls --filter "name=^$VolumeName`$" --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect Docker volumes.' }
if (-not ($volumeExists -contains $VolumeName)) {
  & docker volume create $VolumeName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Docker volume.' }
}
$containerExists = & docker ps -a --filter "name=^/$ContainerName`$" --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect Docker containers.' }
if ($containerExists -contains $ContainerName) {
  & docker rm -f $ContainerName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to replace the existing n8n container.' }
}

$workflowMount = $WorkflowDirectory.Replace('\', '/')
$dockerArgs = @(
  'run', '-d'
  '--name', $ContainerName
  '--restart', 'unless-stopped'
  '--network', $NetworkName
  '--network-alias', 'n8n'
  '-p', "127.0.0.1:$($Port):5678"
  '--env-file', $EnvFile
  '-v', "$VolumeName`:/home/node/.n8n"
  '-v', "$workflowMount`:/workflows:ro"
  $N8nImage
)
& docker @dockerArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to start the n8n container.' }
if ($ImageDockerNetwork -and $ImageDockerNetwork -ne $NetworkName) {
  & docker network connect $ImageDockerNetwork $ContainerName
  if ($LASTEXITCODE -ne 0) { throw "Failed to connect n8n to the image service network: $ImageDockerNetwork" }
}
Wait-N8n $Port

$settings = Get-N8nSettings $Port
if ($settings.data.userManagement.showSetupOnFirstLoad) {
  $ownerBody = @{
    email = $OwnerEmail
    firstName = 'EWS'
    lastName = 'Admin'
    password = $OwnerPassword
  } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/rest/owner/setup" -ContentType 'application/json' -Body $ownerBody -TimeoutSec 20 | Out-Null
}
$OwnerPassword = $null
$settings = Get-N8nSettings $Port
if ($settings.data.userManagement.showSetupOnFirstLoad) {
  throw 'n8n owner setup did not complete. Review the owner email and password, then run the installer again.'
}

& docker exec -e "IMAGE_SERVICE_URL=$ImageServiceBaseUrl" $ContainerName node -e "const base=process.env.IMAGE_SERVICE_URL.replace(/\/+$/,'');fetch(base+'/readyz').then(async r=>{if(!r.ok){console.error(await r.text());process.exit(1)}}).catch(e=>{console.error(e.message);process.exit(1)})"
if ($LASTEXITCODE -ne 0) { throw "Image service is not ready: $ImageServiceBaseUrl/readyz" }

try {
  & docker cp "$CredentialDirectory/." "$($ContainerName):/tmp/ews-credentials"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to copy credentials into n8n.' }
  & docker exec $ContainerName n8n import:credentials --separate --input=/tmp/ews-credentials
  if ($LASTEXITCODE -ne 0) { throw 'Credential import failed.' }
} finally {
  try {
    & docker exec -u 0 $ContainerName node -e "require('fs').rmSync('/tmp/ews-credentials',{recursive:true,force:true})" 2>$null | Out-Null
  } catch {}
  if (Test-Path -LiteralPath $CredentialDirectory) { [IO.Directory]::Delete($CredentialDirectory, $true) }
}

& docker exec $ContainerName n8n import:workflow --separate --input=/workflows
if ($LASTEXITCODE -ne 0) { throw 'Workflow import failed.' }
foreach ($workflowId in $workflowIds) {
  & docker exec $ContainerName n8n publish:workflow --id=$workflowId
  if ($LASTEXITCODE -ne 0) { throw "Workflow publish failed: $workflowId" }
}
& docker restart $ContainerName | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to restart n8n.' }
Wait-N8n $Port

$activeWorkflows = & docker exec $ContainerName n8n list:workflow --active=true
if ($LASTEXITCODE -ne 0) { throw 'Failed to verify active workflows.' }
foreach ($workflowId in $workflowIds) {
  if (-not ($activeWorkflows -match ([regex]::Escape("$workflowId|")))) {
    throw "Workflow is not active after deployment: $workflowId"
  }
}

Write-Host ''
Write-Host 'EWS n8n node deployed successfully.' -ForegroundColor Green
Write-Host "Public URL: $PublicUrl"
Write-Host "Local health: http://127.0.0.1:$Port/healthz"
Write-Host "Docker network: $NetworkName"
Write-Host 'Cloudflare origin service: http://n8n:5678'
Write-Host "Image service: $ImageServiceBaseUrl"
Write-Host ''
Write-Host 'This generated installer contains encoded API keys. Delete it after deployment.' -ForegroundColor Yellow
