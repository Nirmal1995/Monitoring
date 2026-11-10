# StreamHub Phase 0: Windows host inspection (read-only; only writes windows-report.txt next to this script)
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'
$out = Join-Path $PSScriptRoot 'windows-report.txt'
function Section($t) { "`n===== $t =====" }
function Try-Cmd([string]$label, [scriptblock]$sb) {
  Section $label
  try { & $sb 2>&1 | Out-String -Width 200 } catch { "ERROR: $($_.Exception.Message)" }
}
function Try-Timed([string]$label, [string]$cmd, [int]$sec = 30) {
  Section $label
  $j = Start-Job -ScriptBlock { param($c) Invoke-Expression "$c 2>&1" | Out-String -Width 200 } -ArgumentList $cmd
  if (Wait-Job $j -Timeout $sec) { Receive-Job $j } else { Stop-Job $j; "TIMED OUT after $sec s (daemon not responding?)" }
  Remove-Job $j -Force
}
& {
  Try-Cmd 'OS' { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | Format-List }
  Try-Cmd 'CPU' { Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, VirtualizationFirmwareEnabled | Format-List }
  Try-Cmd 'RAM (GB)' { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1) }
  Try-Cmd 'Disks' { Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize }
  Try-Cmd 'WSL status' { wsl.exe --status }
  Try-Cmd 'WSL version' { wsl.exe --version }
  Try-Cmd 'WSL distros' { wsl.exe -l -v }
  Try-Cmd '.wslconfig' { $p = Join-Path $env:USERPROFILE '.wslconfig'; if (Test-Path $p) { Get-Content $p } else { 'not present' } }
  foreach ($c in 'node','npm','pnpm','git') {
    Try-Cmd "Windows PATH: $c" { $cmd = Get-Command $c -ErrorAction SilentlyContinue; if ($cmd) { $cmd.Source; & $c --version } else { 'not installed on Windows PATH' } }
  }
  Try-Timed 'Docker version' 'docker version'
  Try-Timed 'Docker compose' 'docker compose version'
  Try-Timed 'Docker info' "docker info --format 'Server={{.ServerVersion}} OS={{.OperatingSystem}} CPUs={{.NCPU}} MemBytes={{.MemTotal}} Root={{.DockerRootDir}}'"
  Try-Timed 'Docker hello-world' 'docker run --rm hello-world' 120
  $ports = 3000,4000,5173,8080,8025,1025,27017,6379,9000,9001
  Try-Cmd 'Listening ports of interest' { $r = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | Select-Object LocalAddress, LocalPort, OwningProcess, @{n='Process';e={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} | Sort-Object LocalPort; if ($r) { $r | Format-Table -AutoSize } else { 'none of the candidate ports are in use' } }
  Try-Cmd 'Reserved TCP port ranges (Hyper-V/WinNAT)' { netsh interface ipv4 show excludedportrange protocol=tcp }
} | Out-File -FilePath $out -Encoding utf8
"Report written to $out"
