
$ErrorActionPreference='SilentlyContinue'
$ppt = 'E:/Fab/fab-mes/fab-mes-平台介绍.pptx'
$out = 'E:/Fab/fab-mes/qa3'
$app = New-Object -ComObject PowerPoint.Application
$p = $app.Presentations.Open($ppt, $false, $true, $false)
$p.Export($out, 'PNG', 1280, 720)
$p.Close()
$app.Quit()
Write-Host ('exported ' + (Get-ChildItem $out).Count + ' slides')
