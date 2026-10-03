# 動作確認用の簡易Webサーバー（public/ を http://localhost:8080/ で配信）
param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'public'
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.webmanifest' = 'application/manifest+json'; '.png' = 'image/png'; '.json' = 'application/json'
  '.wasm' = 'application/wasm'; '.svg' = 'image/svg+xml'; '.txt' = 'text/plain; charset=utf-8'
}
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/"
$root = [System.IO.Path]::GetFullPath($root)
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    $res = $ctx.Response
    if ($file.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path $file -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file)
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "200 /$path"
    } else {
      $res.StatusCode = 404
      Write-Host "404 /$path"
    }
    $res.Close()
  } catch {
    Write-Host "error: $($_.Exception.Message)"
  }
}
