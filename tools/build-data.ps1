# data-src/<メーカー>/p*.tsv から public/data.js と確認用CSVを生成する
#
# TSV列（メーカー共通の先頭9列）:
#   0 ページ, 1 機種区分, 2 型式, 3 エンジン, 4 シリアル, 5 オイル, 6 エア, 7 燃料, 8 作動油
# 続く列はメーカーごとに異なる（data-src/makers.json の cols で決まる）:
#   コマツ: 9 備考
#   CAT/日立: 9 ST/サクション, 10 TM/ドレン・パイロット, 11 備考
#
# 検証状態 status:
#   checked    = 同じページを2回読み取り、差分を原本で確定したページ（data-src/checked.json に記載）
#   unverified = それ以外（読み取りルール適用前のデータ、または2回読み未実施）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root 'data-src'
$utf8 = New-Object System.Text.UTF8Encoding $false
$makers = Get-Content (Join-Path $src 'makers.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$checked = @{}
$cf = Join-Path $src 'checked.json'
if (Test-Path $cf) { (Get-Content $cf -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $checked[$_.Name] = @($_.Value) } }

# 出力列: [メーカー, ページ, 区分, 型式, エンジン, シリアル, オイル, エア, 燃料, 作動油, ST, TM, 備考, 〃列, status]
$rows = New-Object System.Collections.Generic.List[object]
foreach ($mk in $makers) {
  $dir = Join-Path $src $mk.id
  if (-not (Test-Path $dir)) { continue }
  $width = if ($mk.cols.Count -gt 4) { 12 } else { 10 }
  $prev = @('', '', '', '')
  foreach ($file in Get-ChildItem $dir -Filter 'p*.tsv' | Sort-Object Name) {
    $lineNo = 0
    foreach ($line in [System.IO.File]::ReadAllLines($file.FullName, $utf8)) {
      $lineNo++
      if ($line.Trim() -eq '') { continue }
      $c = $line.Split("`t")
      if ($c.Count -gt $width) { throw "$($mk.id)/$($file.Name):$lineNo 列が多すぎます ($($c.Count) > $width)" }
      $c = @($c + (@('') * ($width - $c.Count)))
      $c = @($c | ForEach-Object { $_.Trim() })
      $ditto = @()
      for ($i = 0; $i -lt 4; $i++) {
        if ($c[5 + $i] -eq '〃') { $c[5 + $i] = $prev[$i]; $ditto += $i }
        $c[5 + $i] = $c[5 + $i] -replace '^\[(.*)\]$', '$1'   # [ ] は薄い文字を示す目印
        $prev[$i] = $c[5 + $i]
      }
      $st = ''; $tm = ''; $note = ''
      if ($width -eq 12) {
        foreach ($k in 9, 10) { $c[$k] = $c[$k] -replace '^\[(.*)\]$', '$1' }
        $st = $c[9]; $tm = $c[10]; $note = $c[11]
      } else { $note = $c[9] }
      $page = [int]$c[0]
      $isChecked = $checked.ContainsKey($mk.id) -and ($checked[$mk.id] -contains $page)
      $rows.Add([object[]]@($mk.id, $page, $c[1], $c[2], $c[3], $c[4], $c[5], $c[6], $c[7], $c[8], $st, $tm, $note, ($ditto -join ''), $(if ($isChecked) { 'checked' } else { 'unverified' })))
    }
  }
}

$json = ConvertTo-Json -InputObject $rows.ToArray() -Depth 3 -Compress
$mjson = ConvertTo-Json -InputObject @($makers) -Depth 5 -Compress
$stamp = Get-Date -Format 'yyyy-MM-dd'
$js = "// 自動生成: tools/build-data.ps1（元データ: data-src/*）`n" +
      "// 列: [メーカー, ページ, 区分, 型式, エンジン, シリアル, オイル, エア, 燃料, 作動油, ST/サクション, TM/ドレン・パイロット, 備考, 〃置換列, status]`n" +
      "window.ELEMENT_DATA = {`"built`":`"$stamp`",`"makers`":$mjson,`"rows`":$json};`n"
[System.IO.File]::WriteAllText((Join-Path $root 'public\data.js'), $js, $utf8)

# 確認用CSV（Excelで開けるようBOM付き）
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('メーカー,ページ,機種区分,型式,エンジン,シリアル,オイル,エア,燃料,作動油,ST/サクション,TM/ドレン・パイロット,備考,検証状態')
foreach ($r in $rows) {
  $cells = foreach ($i in 0..12 + 14) { '"' + ([string]$r[$i]).Replace('"', '""') + '"' }
  [void]$sb.AppendLine($cells -join ',')
}
[System.IO.File]::WriteAllText((Join-Path $root 'エレメント一覧.csv'), $sb.ToString(), (New-Object System.Text.UTF8Encoding $true))

# 原本での確認が必要な行（備考に注記あり、または ??? を含む）
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('メーカー,ページ,機種区分,型式,シリアル,確認内容')
$check = 0
foreach ($r in $rows) {
  $hasUnknown = (($r[6..12] -join '|') -match '\?\?\?')
  if ($hasUnknown -or ([string]$r[12] -match '確認|判読|欠け|不確実|検証中')) {
    $check++
    $cells = foreach ($i in 0, 1, 2, 3, 5, 12) { '"' + ([string]$r[$i]).Replace('"', '""') + '"' }
    [void]$sb.AppendLine($cells -join ',')
  }
}
[System.IO.File]::WriteAllText((Join-Path $root '要確認一覧.csv'), $sb.ToString(), (New-Object System.Text.UTF8Encoding $true))

$by = $rows | Group-Object { $_[0] } | ForEach-Object { "$($_.Name)=$($_.Count)" }
"rows: $($rows.Count) ($($by -join ' / ')) / 要確認: $check / checked: $(($rows | Where-Object { $_[14] -eq 'checked' }).Count)"
