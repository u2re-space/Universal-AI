$ai = Join-Path $PSScriptRoot 'ai.js'
try {
  if ($MyInvocation.ExpectingInput) { $input | & node $ai @args } else { & node $ai @args }
} catch {
  Write-Error $_
  exit 1
}
exit $LASTEXITCODE
