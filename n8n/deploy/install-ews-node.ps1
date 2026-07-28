[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$N8nImage = 'n8nio/n8n:2.25.7'
$ImageServiceImage = 'ews-image-service:2026.07.28'
$ValkeyImage = 'valkey/valkey:8-alpine'

function Decode-Value([string]$Value) {
  if (-not $Value -or $Value.StartsWith('__EWS_')) {
    throw 'Installer parameters are incomplete. Generate this script from the EWS admin deployment page.'
  }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}

function Test-DockerEngine {
  & docker version --format '{{.Server.Version}}' 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Wait-DockerDesktop([int]$Attempts = 90) {
  if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install Docker Desktop, then run this file again.'
  }
  if (Test-DockerEngine) { return }

  $dockerDesktopPath = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path -LiteralPath $dockerDesktopPath)) {
    throw 'Docker Desktop was not found. Install Docker Desktop, then run this file again.'
  }

  Write-Host 'Docker Engine is not ready. Starting Docker Desktop and waiting...' -ForegroundColor Yellow
  if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    try {
      Start-Process -FilePath $dockerDesktopPath
    } catch {
      throw "Failed to start Docker Desktop: $($_.Exception.Message)"
    }
  }

  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    Start-Sleep -Seconds 2
    if (Test-DockerEngine) {
      Write-Host 'Docker Engine is ready.' -ForegroundColor Green
      return
    }
  }
  throw "Docker Desktop did not make the Linux container engine ready within $($Attempts * 2) seconds. Open Docker Desktop, confirm the engine is running with Linux containers enabled, then run this file again."
}

function Wait-DockerContainerNetwork([string]$ContainerName, [int]$Attempts = 15) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    try {
      $containerJson = & docker inspect $ContainerName 2>$null
      if ($LASTEXITCODE -eq 0 -and $containerJson) {
        $containerInfo = $containerJson | ConvertFrom-Json
        $networkName = $containerInfo[0].NetworkSettings.Networks.PSObject.Properties.Name | Select-Object -First 1
        if ($networkName) { return ([string]$networkName).Trim() }
      }
    } catch {}
    if ($attempt -lt $Attempts - 1) { Start-Sleep -Seconds 2 }
  }
  return ''
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

function Test-LocalImageService([string]$ContainerName, [string]$CallbackSecret) {
  & docker exec -e "EWS_CHECK_SECRET=$CallbackSecret" $ContainerName node -e "fetch('http://127.0.0.1:3000/v1/stats',{headers:{authorization:'Bearer '+process.env.EWS_CHECK_SECRET}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Wait-LocalImageService([string]$ContainerName, [string]$CallbackSecret, [int]$Attempts = 60) {
  for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
    if (Test-LocalImageService $ContainerName $CallbackSecret) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Write-ImageServiceSource([string]$BundleJson, [string]$SourceRoot) {
  $expectedFiles = @(
    'Dockerfile', 'package.json', 'package-lock.json',
    'src/app.js', 'src/config.js', 'src/errors.js', 'src/image.js', 'src/pipeline.js',
    'src/queue.js', 'src/security.js', 'src/server.js', 'src/worker-api.js', 'src/worker.js'
  )
  $parsedEntries = $BundleJson | ConvertFrom-Json
  $entries = @($parsedEntries)
  if ($entries.Count -ne $expectedFiles.Count) {
    throw "Image service bundle is incomplete: expected $($expectedFiles.Count) files, found $($entries.Count)."
  }

  $entryMap = @{}
  foreach ($entry in $entries) {
    $name = [string]$entry.name
    if (-not ($expectedFiles -contains $name) -or $entryMap.ContainsKey($name) -or $null -eq $entry.content) {
      throw "Image service bundle entry is invalid: $name"
    }
    $entryMap[$name] = [string]$entry.content
  }
  foreach ($name in $expectedFiles) {
    if (-not $entryMap.ContainsKey($name)) { throw "Image service bundle file is missing: $name" }
  }

  if (Test-Path -LiteralPath $SourceRoot) { [IO.Directory]::Delete($SourceRoot, $true) }
  New-Item -ItemType Directory -Path $SourceRoot -Force | Out-Null
  $normalizedRoot = [IO.Path]::GetFullPath($SourceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  foreach ($name in $expectedFiles) {
    $target = [IO.Path]::GetFullPath((Join-Path $SourceRoot $name.Replace('/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $target.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Image service bundle escaped its source directory.'
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Write-Utf8NoBom $target $entryMap[$name]
  }
}

function Install-LocalImageService([string]$BundleJson, [string]$CallbackSecret, [string]$TicketOrigin) {
  $serviceRoot = Join-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EWS') 'image-service'
  $sourceRoot = Join-Path $serviceRoot 'source'
  $envFile = Join-Path $serviceRoot 'image-service.env'
  $networkName = 'ews-image-service'
  $volumeName = 'ews_image_valkey_data'
  $valkeyContainer = 'ews-image-valkey'
  $apiContainer = 'ews-image-sidecar'
  $workerContainer = 'ews-image-worker'

  New-Item -ItemType Directory -Path $serviceRoot -Force | Out-Null
  Write-Host 'Preparing the bundled EWS image service...' -ForegroundColor Yellow
  Write-ImageServiceSource $BundleJson $sourceRoot
  & docker build --tag $ImageServiceImage $sourceRoot | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Failed to build the EWS image service.' }

  & docker network inspect $networkName 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & docker network create $networkName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the image service Docker network.' }
  }
  & docker volume inspect $volumeName 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    & docker volume create $volumeName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the image service Valkey volume.' }
  }

  foreach ($container in @($workerContainer, $apiContainer, $valkeyContainer)) {
    & docker rm -f $container 2>$null | Out-Null
  }

  $valkeyArgs = @(
    'run', '-d', '--name', $valkeyContainer, '--restart', 'unless-stopped',
    '--network', $networkName, '--network-alias', 'valkey',
    '-v', "$volumeName`:/data", $ValkeyImage,
    'valkey-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--maxmemory-policy', 'noeviction'
  )
  & docker @valkeyArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start the image service Valkey container.' }
  $valkeyReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker exec $valkeyContainer valkey-cli ping 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $valkeyReady = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $valkeyReady) { throw 'Image service Valkey did not become ready within 60 seconds.' }

  $imageEnv = @(
    "IMAGE_SERVICE_SECRET=$CallbackSecret"
    'REDIS_URL=redis://valkey:6379'
    "TICKET_ORIGIN=$TicketOrigin"
    'WORKER_CONCURRENCY=8'
    'MAX_QUEUE_DEPTH=10000'
    'JPEG_QUALITY=88'
    'MAX_OUTPUT_BYTES=1900000'
    'ALLOW_BENCHMARK_DNS=false'
    'LOG_LEVEL=info'
  )
  [IO.File]::WriteAllLines($envFile, $imageEnv, (New-Object Text.UTF8Encoding($false)))
  try {
    $apiArgs = @(
      'run', '-d', '--name', $apiContainer, '--restart', 'unless-stopped',
      '--network', $networkName, '--network-alias', 'ews-image-sidecar',
      '--env-file', $envFile, $ImageServiceImage
    )
    & docker @apiArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start the EWS image API container.' }

    $workerArgs = @(
      'run', '-d', '--name', $workerContainer, '--restart', 'unless-stopped',
      '--network', $networkName, '--env-file', $envFile,
      $ImageServiceImage, 'npm', 'run', 'worker'
    )
    & docker @workerArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start the EWS image worker container.' }
  } finally {
    if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile -Force }
  }

  if (-not (Wait-LocalImageService $apiContainer $CallbackSecret)) {
    throw 'EWS image service did not become ready within 120 seconds.'
  }
  Write-Host 'EWS image service deployed successfully.' -ForegroundColor Green
  return $networkName
}

function Ensure-LocalImageService([string]$BundleJson, [string]$CallbackSecret, [string]$TicketOrigin) {
  $containerName = 'ews-image-sidecar'
  $networkName = Wait-DockerContainerNetwork $containerName 3
  if ($networkName) {
    foreach ($container in @('ews-image-valkey', $containerName, 'ews-image-worker')) {
      & docker start $container 2>$null | Out-Null
    }
    if (Wait-LocalImageService $containerName $CallbackSecret 30) {
      Write-Host "Reusing the local image service on Docker network: $networkName" -ForegroundColor Green
      return $networkName
    }
    Write-Host 'The existing image service is not healthy and will be replaced.' -ForegroundColor Yellow
  }
  return Install-LocalImageService $BundleJson $CallbackSecret $TicketOrigin
}

$NodeName = Decode-Value $env:EWS_NODE_NAME_B64
$Domain = Decode-Value $env:EWS_DOMAIN_B64
$OwnerEmail = Decode-Value $env:EWS_OWNER_EMAIL_B64
$OwnerPassword = Decode-Value $env:EWS_OWNER_PASSWORD_B64
$GrsaiKey = (Decode-Value $env:EWS_GRSAI_KEY_B64).Trim()
$DeepseekKey = (Decode-Value $env:EWS_DEEPSEEK_KEY_B64).Trim()
$BackupKey = (Decode-Value $env:EWS_BACKUP_KEY_B64).Trim()
$ImageServiceInput = (Decode-Value $env:EWS_IMAGE_SERVICE_URL_B64).Trim()
$CallbackSecret = (Decode-Value $env:EWS_CALLBACK_SECRET_B64).Trim()
$TicketOriginInput = (Decode-Value $env:EWS_TICKET_ORIGIN_B64).Trim()
$WorkflowBundleJson = Decode-Value '__EWS_WORKFLOW_BUNDLE_B64__'
$ImageServiceBundleJson = Decode-Value '__EWS_IMAGE_SIDECAR_BUNDLE_B64__'
$Port = [int]$env:EWS_PORT

if ($NodeName -notmatch '^[a-z0-9][a-z0-9-]{0,31}$') { throw 'Node name must contain only lowercase letters, numbers, and hyphens.' }
if ($Domain -notmatch '^[A-Za-z0-9.-]+$' -or $Domain.Contains('..')) { throw 'Public domain is invalid.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
if ($OwnerEmail -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw 'n8n owner email is invalid.' }
if ($OwnerPassword.Length -lt 8 -or $OwnerPassword.Length -gt 64) { throw 'n8n owner password must contain 8 to 64 characters.' }
if ($OwnerPassword -notmatch '[A-Z]') { throw 'n8n owner password must contain at least one uppercase letter.' }
if ($OwnerPassword -notmatch '\d') { throw 'n8n owner password must contain at least one number.' }
if (-not $GrsaiKey -or -not $DeepseekKey -or -not $BackupKey) { throw 'All three model API keys are required.' }
if ($CallbackSecret -match '[\r\n]') { throw 'EWS callback secret is invalid.' }

try {
  $ticketUri = [Uri]$TicketOriginInput
} catch {
  throw 'EWS Worker origin is invalid.'
}
if ($ticketUri.Scheme -notin @('http', 'https')) { throw 'EWS Worker origin must use HTTP or HTTPS.' }
$TicketOrigin = $ticketUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')

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

Wait-DockerDesktop

$ImageDockerNetwork = ''
if ($imageUri.Host -eq 'ews-image-sidecar') {
  if (-not $CallbackSecret) { throw 'EWS callback secret is required to deploy the local image service.' }
  $ImageDockerNetwork = Ensure-LocalImageService $ImageServiceBundleJson $CallbackSecret $TicketOrigin
}
$CallbackSecret = $null
$ImageServiceBundleJson = $null

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
