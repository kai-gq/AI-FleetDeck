# Phone Link(手机连接)通知读取操作流程

> 本机(Windows 11 专业版)实测固化的流程记录,2026-10-07 小刘复盘整理。
> 用途:老板问「手机最新通知」时,按本文标准步骤直接复用,全程只读。

## 1. 启动方式

Phone Link 是 UWP 应用(AppID `Microsoft.YourPhone_8wekyb3d8bbwe`),启动命令(cmd 通道):

```
start shell:AppsFolder\Microsoft.YourPhone_8wekyb3d8bbwe!App
```

注:windows-cli MCP 的 cmd 通道会剥掉引号,`dir /b "C:\Program Files"`、`tasklist /fi "..."` 这类带引号命令会语法报错,优先用不带引号的形式或 PowerShell 通道。

## 2. PID / 进程验证

主进程名 `PhoneExperienceHost`。验证是否在运行(PowerShell 单表达式,避开 `;`/`|`/`&` 白名单):

```
Get-Process PhoneExperienceHost
```

窗口标题可用 `(Get-Process PhoneExperienceHost).MainWindowTitle` 查(正常为「手机连接」)。

安装位置与版本:

```
(Get-AppxPackage Microsoft.YourPhone).InstallLocation
(Get-AppxPackage Microsoft.YourPhone).Version
```

本机实测:C:\Program Files\WindowsApps\Microsoft.YourPhone_1.26072.257.0_x64__8wekyb3d8bbwe,版本 1.26072.257.0。

## 3. 读取通知的可行手段与限制

| 手段 | 结论 |
|---|---|
| 本地数据文件 | ❌ 不可行。YourPhone 包目录(`%LOCALAPPDATA%\Packages\Microsoft.YourPhone_8wekyb3d8bbwe`)下只有 calling/contacts/phoneapps/settings 四个 sqlite,**没有 notifications.db,settings 全表 0 行**;通知不落本地库,只在 GUI 层 |
| 截图 + 读图/OCR | ❌ 不可靠。全屏截图(CopyFromScreen)可行,但窗口内文字经读图无法可靠辨认 |
| UI Automation 控件树遍历 | ✅ **已验证可行**。PowerShell UIA 遍历 PhoneExperienceHost 窗口控件树,读 Text/ListItem/Button/TabItem/Header 的 Name 属性,可完整读出通知列表(应用名+内容+时间) |

### 关键坑(已踩过)

1. **中文乱码**:PowerShell stdout 直接打印中文会 GBK 乱码;必须 `[Console]::OutputEncoding = UTF8` 且用 `WriteAllLines(..., UTF8Encoding($false))` 落盘后再读文件。
2. **界面连接提示与历史通知可并存**:界面底部可能出现「我们无法连接到你的移动设备…重试」提示(蓝牙连接断),但「通知」面板里的历史通知仍可正常读取——照读不误。
3. **配对设备确认**:`LocalCache/DeviceMetadataStorage.json` 可看配对设备元数据(本机配对的是 iPhone (2));但手机通知不在任何本地 db,不用再找。

## 4. 标准步骤(取最新几条通知)

1. **确保进程在跑**:`Get-Process PhoneExperienceHost`;不在则执行第 1 节的 start 命令,等 2~3 秒。
2. **(可选)激活窗口到前台**:`AppActivate($p.Id)`(Microsoft.VisualBasic),保证控件树完整可见(实测不激活也能读到)。
3. **跑 UIA 遍历脚本**(保存为 .ps1 后 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` 执行):

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p = Get-Process PhoneExperienceHost -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'NO_PROCESS'; exit }
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'NO_WINDOW'; exit }
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$lines = @()
foreach ($e in $all) {
  $t = $e.Current.ControlType.ProgrammaticName
  if ($t -match 'Text|ListItem|Button|TabItem|Header') {
    $n = $e.Current.Name
    if ($n -and $n.Trim().Length -gt 0 -and $n.Trim().Length -lt 400) { $lines += $t.Replace('ControlType.','') + ' | ' + $n }
  }
}
[System.IO.File]::WriteAllLines('E:/tmp/uia-out.txt', $lines, (New-Object System.Text.UTF8Encoding $false))
```

4. **读结果**:读 `E:/tmp/uia-out.txt`。`ListItem | <类型> <号码>  <内容>  <时间>` 行就是通知条目(类型=信息/电话 等),按界面顺序即从新到旧。去重:每条 ListItem 后跟的 Text 行是同一通知的展开字段,取 ListItem 行即可。
5. **整理输出**:格式「应用名(号码) + 内容 + 时间」从新到旧列出。
6. **纪律**:全程只读;界面上的「清除所有通知」「重试」等按钮一律不点。

## 5. 本机其它「连接手机」类软件

- 向日葵远程控制:`E:\xiangrikui\AweSun\AweSun.exe`(未实测通知读取,远程控制为主)。
