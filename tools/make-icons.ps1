# public/icons/ にPWA用アイコンPNGを生成する（外部素材を使わない自作図形）
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root 'public\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [string]$name, [double]$pad, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $navy = [System.Drawing.Color]::FromArgb(255, 18, 58, 99)
  $bg = New-Object System.Drawing.SolidBrush $navy
  if ($rounded) {
    $r = $size * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($size - $r, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $path.AddArc(0, $size - $r, $r, $r, 90, 90)
    $path.CloseFigure(); $g.FillPath($bg, $path)
  } else {
    $g.FillRectangle($bg, 0, 0, $size, $size)
  }
  # 描画領域（maskable は中央80%に収める）
  $s = $size * (1 - 2 * $pad); $o = $size * $pad
  function X([double]$f) { $o + $s * $f }
  # フィルターエレメント（円筒＋ひだ）
  $body = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 236, 241, 247))
  $cap = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 150, 170, 196))
  $g.FillRectangle($cap, (X 0.16), (X 0.14), $s * 0.46, $s * 0.08)
  $g.FillRectangle($body, (X 0.19), (X 0.22), $s * 0.40, $s * 0.54)
  $g.FillRectangle($cap, (X 0.16), (X 0.76), $s * 0.46, $s * 0.08)
  $pleat = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 150, 170, 196)), ([Math]::Max(1, $s * 0.018))
  foreach ($f in 0.26, 0.33, 0.40, 0.47, 0.54) { $g.DrawLine($pleat, (X $f), (X 0.25), (X $f), (X 0.73)) }
  # 虫めがね
  $amber = [System.Drawing.Color]::FromArgb(255, 255, 196, 0)
  $lens = New-Object System.Drawing.Pen $amber, ($s * 0.07)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 255, 255, 255))), (X 0.44), (X 0.40), $s * 0.34, $s * 0.34)
  $g.DrawEllipse($lens, (X 0.44), (X 0.40), $s * 0.34, $s * 0.34)
  $handle = New-Object System.Drawing.Pen $amber, ($s * 0.10)
  $handle.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $handle.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($handle, (X 0.73), (X 0.69), (X 0.86), (X 0.82))
  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $name
}

New-Icon 192 'icon-192.png' 0.06 $true
New-Icon 512 'icon-512.png' 0.06 $true
New-Icon 512 'icon-maskable-512.png' 0.12 $false
New-Icon 180 'apple-touch-icon.png' 0.08 $false
New-Icon 32 'favicon-32.png' 0.02 $true
