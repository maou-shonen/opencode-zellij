import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * 驗證 README 內的 Spec 連結是否還活著。
 *
 * 規則:
 * 1. 從 README.md / README.zh.md 抽出所有 markdown link,目標為 tests/ 下的 .test.ts 檔案。
 * 2. 目標檔案必須存在,否則 exit 1。
 * 3. 對每個目標列出所有 describe / integration / test 的 group 名稱,
 *    供 reviewer 視覺確認 spec 連結指向的章節確實存在。
 *
 * 故意不做 strict name match(把 README section heading 對應到 describe group 名):
 * 那會過度耦合,並鼓勵機械式重命名。Reviewer 看到 Groups: 列表時
 * 自己判斷即可,這也是 AGENTS.md「Test-as-spec discipline」的精神。
 */

// Markdown 連結中指向測試檔的 regex。支援後面帶 anchor 的形式,例如 path#group-name。
const MARKDOWN_TEST_LINK
  = /\[([^\]]*)\]\((tests\/[\w\-/.]+\.test\.ts)(?:#[^)]+)?\)/g

// 描述/整合/測試的呼叫形式,只抓第一個字串參數當 group name。
const GROUP_CALL = /(?:describe|integration|test)\(\s*['"]([^'"]+)['"]/g

interface SpecLink {
  file: string
  text: string
}

function extractSpecLinks(markdown: string): SpecLink[] {
  // 排除 fenced code block:裡面的 tests/... 是範例文字,不是 spec 連結。
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '')
  const links: SpecLink[] = []
  for (const match of withoutFences.matchAll(MARKDOWN_TEST_LINK)) {
    const file = match[2]
    const text = match[1] ?? ''
    if (file)
      links.push({ file, text })
  }
  return links
}

function listGroups(testFile: string): string[] {
  if (!existsSync(testFile))
    return []
  const source = readFileSync(testFile, 'utf8')
  const groups: string[] = []
  for (const match of source.matchAll(GROUP_CALL)) {
    const name = match[1]
    if (name)
      groups.push(name)
  }
  return groups
}

function main(): void {
  const readmes = ['README.md', 'README.zh.md']
  let totalLinks = 0
  let deadLinks = 0

  for (const readme of readmes) {
    if (!existsSync(readme)) {
      console.log(`\n${readme} (skipped: file not found)`)
      continue
    }

    const markdown = readFileSync(readme, 'utf8')
    const links = extractSpecLinks(markdown)
    totalLinks += links.length

    console.log(`\n${readme} (${links.length} spec link${links.length === 1 ? '' : 's'})`)

    // 去重:同一檔案在 README 多次出現只需報一次
    const seen = new Set<string>()
    for (const link of links) {
      if (seen.has(link.file))
        continue
      seen.add(link.file)

      const resolved = resolve(link.file)
      if (!existsSync(link.file)) {
        console.log(`  ✗ ${link.file}`)
        console.log(`    File does not exist (resolved: ${resolved})`)
        deadLinks++
        continue
      }

      const groups = listGroups(link.file)
      const groupsLabel = groups.length > 0 ? groups.join(' | ') : '(no describe/integration groups found)'
      console.log(`  ✓ ${link.file}`)
      console.log(`    Groups: ${groupsLabel}`)
    }
  }

  console.log()
  if (deadLinks > 0) {
    console.error(`Found ${deadLinks} dead spec link${deadLinks === 1 ? '' : 's'}.`)
    process.exit(1)
  }
  console.log(`All ${totalLinks} spec link${totalLinks === 1 ? '' : 's'} are valid.`)
}

main()
