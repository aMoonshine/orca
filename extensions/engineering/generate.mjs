import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const root = import.meta.dirname
const vendor = join(root, 'vendor')
const revision = 'd81f3a183412e71a5b1e84ca21bc1a35eea03a60'
const catalog = []
const hashes = {}
async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    result.push(...(entry.isDirectory() ? await files(path) : [path]))
  }
  return result.sort()
}
for (const path of await files(vendor)) {
  const bytes = await readFile(path)
  hashes[relative(vendor, path).replaceAll('\\', '/')] = createHash('sha256')
    .update(bytes)
    .digest('hex')
  if (!path.endsWith('SKILL.md')) {
    continue
  }
  const markdown = bytes.toString('utf8')
  const name = markdown.match(/^name: (.+)$/m)?.[1].trim()
  const description = markdown
    .match(/^description: (.+)$/m)?.[1]
    .trim()
    .replace(/^"|"$/g, '')
  if (!name || !description) {
    throw new Error(`Missing metadata: ${path}`)
  }
  const resources = []
  for (const resource of await files(dirname(path))) {
    if (resource === path || !resource.endsWith('.md')) {
      continue
    }
    resources.push({
      path: relative(dirname(path), resource).replaceAll('\\', '/'),
      text: await readFile(resource, 'utf8')
    })
  }
  catalog.push({
    name,
    description,
    category: relative(vendor, path).split(/[\\/]/)[1],
    markdown,
    resources
  })
}
catalog.sort((a, b) => a.name.localeCompare(b.name, 'en'))
const outputs = {
  'catalog.generated.json': catalog,
  'source.json': {
    repository: 'https://github.com/mattpocock/skills',
    revision,
    license: 'MIT',
    hashes
  }
}
for (const [name, value] of Object.entries(outputs)) {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const path = join(root, name)
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')) !== content) {
      throw new Error(`Regenerate ${name}`)
    }
  } else {
    await writeFile(path, content)
  }
}
console.log(`Engineering catalog: ${catalog.length} skills`)
