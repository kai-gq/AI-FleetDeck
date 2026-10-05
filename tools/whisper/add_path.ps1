# 把本仓库 whisper 栈的两个目录追加到「当前用户」PATH(幂等,不动已有内容)。
# 用法(由用户亲自执行;加完必须重启 Tide Commander 服务,进程启动时才读 PATH):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\whisper\add_path.ps1
# 目录按本脚本位置推导 —— 仓库挪动后在新位置重跑即可,重复执行安全。
if (-not $PSScriptRoot) {
    Write-Error '请用 -File 方式运行本脚本(powershell -NoProfile -File tools\whisper\add_path.ps1)'
    exit 1
}
$paths = @(
    (Join-Path $PSScriptRoot 'venv\Scripts'),
    (Join-Path $PSScriptRoot 'ffmpeg\bin')
)
$cur = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($cur -split ';' | Where-Object { $_ -ne '' })
$add = @($paths | Where-Object { $parts -notcontains $_ })
if ($add.Count -gt 0) {
    $new = ($parts + $add) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Write-Output ("ADDED: " + ($add -join ';'))
} else {
    Write-Output 'ALREADY_PRESENT'
}
Write-Output '--- NEW USER PATH ---'
[Environment]::GetEnvironmentVariable('Path', 'User')
