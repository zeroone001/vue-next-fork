/* 
  https://juejin.cn/post/6997943192851054606
  命令行参数解析
  其中process.argv的第一和第二个元素是Node可执行文件和被执行JavaScript文件的完全限定的文件系统路径，
  无论你是否这样输入他们
  $ node example/parse.js -x 3 -y 4 -n5 -abc --beep=boop foo bar baz
{ _: [ 'foo', 'bar', 'baz' ],
  x: 3,
  y: 4,
  n: 5,
  a: true,
  b: true,
  c: true,
  beep: 'boop' }
*/
const args = require('minimist')(process.argv.slice(2))
/* 文件模块 */
const fs = require('fs')
/* 路径模块 */
const path = require('path')
/* 控制台 
  终端显示多色彩输出
*/
const chalk = require('chalk')
/* 
  语义化版本
*/
const semver = require('semver')
const currentVersion = require('../package.json').version

/* 
  交互式询问用户输入
  https://github.com/enquirer/enquirer
*/
const { prompt } = require('enquirer')
/* 
在终端命令行执行命令 
类似自己在终端输入命令
*/
const execa = require('execa')

/* 
  对应 yarn run release --preid=beta
*/
const preId =
  args.preid ||
  (semver.prerelease(currentVersion) && semver.prerelease(currentVersion)[0])
/* 对应 yarn run release --dry */
const isDryRun = args.dry
/* 对应 yarn run release --skipTests */
const skipTests = args.skipTests
/* 对应 yarn run release --skipBuild */
const skipBuild = args.skipBuild
/* 读取 packages 文件夹，过滤掉 不是 .ts文件 结尾 并且不是 . 开头的文件夹 */
const packages = fs
  .readdirSync(path.resolve(__dirname, '../packages'))
  .filter(p => !p.endsWith('.ts') && !p.startsWith('.'))

/* 跳过的包 */
const skippedPackages = []
/* 版本递增 */
const versionIncrements = [
  'patch',
  'minor',
  'major',
  ...(preId ? ['prepatch', 'preminor', 'premajor', 'prerelease'] : [])
]
/* inc是生成一个版本 */
const inc = i => semver.inc(currentVersion, i, preId)
/* 获取 bin 命令 */
const bin = name => path.resolve(__dirname, '../node_modules/.bin/' + name)
/* 
run 真实在终端跑命令，比如 yarn build --release

*/
const run = (bin, args, opts = {}) =>
  execa(bin, args, { stdio: 'inherit', ...opts })
/* dryRun 则是不跑，只是 console.log(); 打印 'yarn build --release'

 */
const dryRun = (bin, args, opts = {}) =>
  console.log(chalk.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts)

/* 
  runIfNotDry 如果不是空跑就执行命令。
  isDryRun 参数是通过控制台输入的。
  yarn run release --dry这样就是true。
  runIfNotDry就是只是打印，不执行命令。这样设计的好处在于，
  可以有时不想直接提交，要先看看执行命令的结果

 */
const runIfNotDry = isDryRun ? dryRun : run
/* 获取包的路径 */
const getPkgRoot = pkg => path.resolve(__dirname, '../packages/' + pkg)
/* 控制台输出 */
const step = msg => console.log(chalk.cyan(msg))
/* 
  主入口函数
*/
async function main() {
  /* 版本校验 */
  /* 取到参数 3.2.4 */
  let targetVersion = args._[0]
  /* 

  */
  if (!targetVersion) {
    // no explicit version, offer suggestions
    /* 选择版本 */
    const { release } = await prompt({
      type: 'select',
      name: 'release',
      message: 'Select release type',
      choices: versionIncrements.map(i => `${i} (${inc(i)})`).concat(['custom'])
    })
    /* 如果选了自定义 */
    if (release === 'custom') {
      targetVersion = (
        await prompt({
          type: 'input',
          name: 'version',
          message: 'Input custom version',
          initial: currentVersion
        })
      ).version
    } else {
      /* 取到版本号 */
      targetVersion = release.match(/\((.*)\)/)[1]
    }
  }
  /* 校验版本是否符合规范 */
  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`)
  }
  /* 确认要 release */
  const { yes } = await prompt({
    type: 'confirm',
    name: 'yes',
    message: `Releasing v${targetVersion}. Confirm?`
  })
  /* false 直接返回 */
  if (!yes) {
    return
  }
  /* 上面代码都是确认版本 */
  // run tests before release
  /* bin('jest')
    跑命令测试
    1. 执行测试用例
  */
  step('\nRunning tests...')
  if (!skipTests && !isDryRun) {
    await run(bin('jest'), ['--clearCache'])
    await run('pnpm', ['test', '--', '--bail'])
  } else {
    console.log(`(skipped)`)
  }

  // update all package versions and inter-dependencies
  /* 
     更新所有包的版本号和内部 vue 相关依赖版本号
  */
  step('\nUpdating cross dependencies...')
  updateVersions(targetVersion)

  // build all packages with types
  /* 
    打包编译所有的包
  */
  step('\nBuilding all packages...')
  if (!skipBuild && !isDryRun) {
    await run('pnpm', ['run', 'build', '--', '--release'])
    // test generated dts files
    step('\nVerifying type declarations...')
    await run('pnpm', ['run', 'test-dts-only'])
  } else {
    console.log(`(skipped)`)
  }

  // generate changelog
  /* 
    生成changelog
    https://github.com/conventional-changelog/conventional-changelog
  */
  step('\nGenerating changelog...')
  await run(`pnpm`, ['run', 'changelog'])

  // update pnpm-lock.yaml
  /* 
    更新 pnpm-lock.yaml
  */
  step('\nUpdating lockfile...')
  await run(`pnpm`, ['install', '--prefer-offline'])
  /* 
    提交代码
  */
  const { stdout } = await run('git', ['diff'], { stdio: 'pipe' })
  if (stdout) {
    /* 如果有变化 */
    step('\nCommitting changes...')
    await runIfNotDry('git', ['add', '-A'])
    await runIfNotDry('git', ['commit', '-m', `release: v${targetVersion}`])
  } else {
    console.log('No changes to commit.')
  }

  // publish packages
  /* 
    发布包
  */
  step('\nPublishing packages...')
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry)
  }

  // push to GitHub
  /* 
    推送到GitHub
  */
  step('\nPushing to GitHub...')
  await runIfNotDry('git', ['tag', `v${targetVersion}`])
  /* 推送 tag */
  await runIfNotDry('git', ['push', 'origin', `refs/tags/v${targetVersion}`])
  /* git push 所有改动到 远程  - github */
  await runIfNotDry('git', ['push'])

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`)
  }

  if (skippedPackages.length) {
    console.log(
      chalk.yellow(
        `The following packages are skipped and NOT published:\n- ${skippedPackages.join(
          '\n- '
        )}`
      )
    )
  }
  console.log()
}

function updateVersions(version) {
  // 1. update root package.json
  updatePackage(path.resolve(__dirname, '..'), version)
  // 2. update all packages
  packages.forEach(p => updatePackage(getPkgRoot(p), version))
}

function updatePackage(pkgRoot, version) {
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  pkg.version = version
  /* packages.json 中 dependencies 中 vue 相关的依赖修改 */
  updateDeps(pkg, 'dependencies', version)
  /* packages.json 中 peerDependencies 中 vue 相关的依赖修改 */
  updateDeps(pkg, 'peerDependencies', version)
  /* 自己本身 package.json 的版本号 修改 */
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}
/* 
  updateDeps 更新内部 vue 相关依赖的版本号
*/
function updateDeps(pkg, depType, version) {
  const deps = pkg[depType]
  if (!deps) return
  Object.keys(deps).forEach(dep => {
    if (
      dep === 'vue' ||
      (dep.startsWith('@vue') && packages.includes(dep.replace(/^@vue\//, '')))
    ) {
      console.log(
        chalk.yellow(`${pkg.name} -> ${depType} -> ${dep}@${version}`)
      )
      deps[dep] = version
    }
  })
}

async function publishPackage(pkgName, version, runIfNotDry) {
  if (skippedPackages.includes(pkgName)) {
    return
  }
  const pkgRoot = getPkgRoot(pkgName)
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  if (pkg.private) {
    return
  }

  // For now, all 3.x packages except "vue" can be published as
  // `latest`, whereas "vue" will be published under the "next" tag.
  let releaseTag = null
  if (args.tag) {
    releaseTag = args.tag
  } else if (version.includes('alpha')) {
    releaseTag = 'alpha'
  } else if (version.includes('beta')) {
    releaseTag = 'beta'
  } else if (version.includes('rc')) {
    releaseTag = 'rc'
  } else if (pkgName === 'vue') {
    // TODO remove when 3.x becomes default
    releaseTag = 'next'
  }

  // TODO use inferred release channel after official 3.0 release
  // const releaseTag = semver.prerelease(version)[0] || null

  step(`Publishing ${pkgName}...`)
  try {
    await runIfNotDry(
      // note: use of yarn is intentional here as we rely on its publishing
      // behavior.
      'yarn',
      [
        'publish',
        '--new-version',
        version,
        ...(releaseTag ? ['--tag', releaseTag] : []),
        '--access',
        'public'
      ],
      {
        cwd: pkgRoot,
        stdio: 'pipe'
      }
    )
    console.log(chalk.green(`Successfully published ${pkgName}@${version}`))
  } catch (e) {
    if (e.stderr.match(/previously published/)) {
      console.log(chalk.red(`Skipping already published: ${pkgName}`))
    } else {
      throw e
    }
  }
}

main().catch(err => {
  console.error(err)
})
