# data-src/*.tsv から public/data.js と コマツ_エレメント一覧.csv を生成する
# TSV列: カタログページ, 機種区分, 型式, エンジン, シリアル, オイル, エア, 燃料, 作動油, 備考
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root 'data-src'
$utf8 = New-Object System.Text.UTF8Encoding $false

$rows = New-Object System.Collections.Generic.List[object]
$prev = @('', '', '', '')
foreach ($file in Get-ChildItem $src -Filter 'p*.tsv' | Sort-Object Name) {
  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadAllLines($file.FullName, $utf8)) {
    $lineNo++
    if ($line.Trim() -eq '') { continue }
    $c = $line.Split("`t")
    if ($c.Count -gt 10) { throw "$($file.Name):$lineNo 列が多すぎます ($($c.Count))" }
    $c = @($c + (@('') * (10 - $c.Count)))
    $c = @($c | ForEach-Object { $_.Trim() })
    # 〃（同上）は直前行の値で置き換え、置き換えた列を記録する
    $ditto = @()
    for ($i = 0; $i -lt 4; $i++) {
      if ($c[5 + $i] -eq '〃') { $c[5 + $i] = $prev[$i]; $ditto += $i }
      # [ ] は淡色の純正番号表記の目印として使っていたので外す
      $c[5 + $i] = $c[5 + $i] -replace '^\[(.*)\]$', '$1'
      $prev[$i] = $c[5 + $i]
    }
    $rows.Add([object[]]@([int]$c[0], $c[1], $c[2], $c[3], $c[4], $c[5], $c[6], $c[7], $c[8], $c[9], ($ditto -join '')))
  }
}

$json = ConvertTo-Json -InputObject $rows.ToArray() -Depth 3 -Compress
$stamp = Get-Date -Format 'yyyy-MM-dd'
$js = "// 自動生成: tools/build-data.ps1（元データ: data-src/*.tsv）`n" +
      "// 列: [ページ, 機種区分, 型式, エンジン, シリアル, オイル, エア, 燃料, 作動油, 備考, 〃置換列]`n" +
      "window.ELEMENT_DATA = {`"source`":`"P.ELE 2026 建機エレメント総合カタログ コマツ（P.1-30）`",`"built`":`"$stamp`",`"rows`":$json};`n"
[System.IO.File]::WriteAllText((Join-Path $root 'public\data.js'), $js, $utf8)

# 確認用CSV（Excelで開けるようBOM付き）
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('ページ,機種区分,型式,エンジン,シリアル,オイル,エア,燃料,作動油,備考')
foreach ($r in $rows) {
  $cells = for ($i = 0; $i -lt 10; $i++) { '"' + ([string]$r[$i]).Replace('"', '""') + '"' }
  [void]$sb.AppendLine($cells -join ',')
}
[System.IO.File]::WriteAllText((Join-Path $root 'コマツ_エレメント一覧.csv'), $sb.ToString(), (New-Object System.Text.UTF8Encoding $true))

# 原本での確認が必要な行だけの一覧
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('ページ,機種区分,型式,シリアル,確認内容')
$check = 0
foreach ($r in $rows) {
  if ([string]$r[9] -match '確認|判読|欠け|不確実|検証中') {
    $check++
    $cells = foreach ($i in 0, 1, 2, 4, 9) { '"' + ([string]$r[$i]).Replace('"', '""') + '"' }
    [void]$sb.AppendLine($cells -join ',')
  }
}
[System.IO.File]::WriteAllText((Join-Path $root '要確認一覧.csv'), $sb.ToString(), (New-Object System.Text.UTF8Encoding $true))
"rows: $($rows.Count) / 要確認: $check"
