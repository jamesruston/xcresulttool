import * as artifact from '@actions/artifact'
import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import * as os from 'os'
import * as path from 'path'
import {Formatter} from './formatter'
import {Octokit} from '@octokit/action'
import {glob} from 'glob'
import {promises} from 'fs'
const {stat} = promises

async function run(): Promise<void> {
  try {
    const inputPaths = core.getMultilineInput('path')
    const showPassedTests = core.getBooleanInput('show-passed-tests')
    const showCodeCoverage = core.getBooleanInput('show-code-coverage')
    let uploadBundles = core.getInput('upload-bundles').toLowerCase()
    if (uploadBundles === 'true') {
      uploadBundles = 'always'
    } else if (uploadBundles === 'false') {
      uploadBundles = 'never'
    }

    const bundlePaths: string[] = []
    for (const checkPath of inputPaths) {
      try {
        await stat(checkPath)
        bundlePaths.push(checkPath)
      } catch (error) {
        core.error((error as Error).message)
      }
    }
    let bundlePath = path.join(os.tmpdir(), 'Merged.xcresult')
    if (inputPaths.length > 1) {
      await mergeResultBundle(bundlePaths, bundlePath)
    } else {
      const inputPath = inputPaths[0]
      await stat(inputPath)
      bundlePath = inputPath
    }

    const formatter = new Formatter(bundlePath)
    const report = await formatter.format({
      showPassedTests,
      showCodeCoverage
    })

    if (core.getInput('token')) {
      await core.summary.addRaw(report.reportSummary).write()

      const octokit = new Octokit()

      const owner = github.context.repo.owner
      const repo = github.context.repo.repo

      const pr = github.context.payload.pull_request
      const sha = (pr && pr.head.sha) || github.context.sha

      const bytesLimit = 65535
      let title = core.getInput('title')
      let reportSummary = report.reportSummary
      let reportDetail = report.reportDetail

      const truncateToBytes = (str: string, maxSize: number): string => {
        let bytes = 0
        let i = 0

        // Iterate through the characters of the string until reaching the byte size limit
        for (; i < str.length && bytes <= maxSize; i++) {
          const charCode = str.charCodeAt(i);

          // Depending on the Unicode code point of the character, add the corresponding byte size
          if (charCode < 128) bytes += 1; // 1 byte for standard ASCII characters
          else if (charCode < 2048) bytes += 2; // 2 bytes for characters in the range 128-2047
          else if (charCode < 65536) bytes += 3; // 3 bytes for characters in the range 2048-65535
          else bytes += 4; // 4 bytes for characters in the range 65536 and above
        }

        // Return the truncated string, cutting it at the position where the byte size limit was reached
        return str.substring(0, i - 1);
      }

      if (Buffer.from(title).length > bytesLimit) {
        core.warning(`The 'title' will be truncated because the byte size limit (${bytesLimit}) exceeded.`)
        title = truncateToBytes(title, bytesLimit)
      }

      if (Buffer.from(report.reportSummary).length > bytesLimit) {
        core.warning(`The 'summary' will be truncated because the byte size limit (${bytesLimit}) exceeded.`)
        reportSummary = truncateToBytes(report.reportSummary, bytesLimit)
      }

      if (Buffer.from(report.reportDetail).length > bytesLimit) {
        core.warning(`The 'text' will be truncated because the byte size limit (${bytesLimit}) exceeded.`)
        reportDetail = truncateToBytes(report.reportDetail, bytesLimit)
      }

      if (report.annotations.length > 50) {
        core.warning(
          'Annotations that exceed the limit (50) will be truncated.'
        )
      }
      const annotations = report.annotations.slice(0, 50)
      let output
      if (reportDetail.trim()) {
        output = {
          title: 'Xcode test results',
          summary: reportSummary,
          text: reportDetail,
          annotations
        }
      } else {
        output = {
          title: 'Xcode test results',
          summary: reportSummary,
          annotations
        }
      }
      await octokit.checks.create({
        owner,
        repo,
        name: title,
        head_sha: sha,
        status: 'completed',
        conclusion: report.testStatus,
        output
      })

      if (
        uploadBundles === 'always' ||
        (uploadBundles === 'failure' && report.testStatus === 'failure')
      ) {
        for (const uploadBundlePath of inputPaths) {
          try {
            await stat(uploadBundlePath)
          } catch (error) {
            continue
          }

          const artifactClient = artifact.create()
          const artifactName = path.basename(uploadBundlePath)

          const rootDirectory = uploadBundlePath
          const options = {
            continueOnError: false
          }

          glob(`${uploadBundlePath}/**/*`, async (error, files) => {
            if (error) {
              core.error(error)
            }
            if (files.length) {
              await artifactClient.uploadArtifact(
                artifactName,
                files,
                rootDirectory,
                options
              )
            }
          })
        }
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()

async function mergeResultBundle(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  const args = ['xcresulttool', 'merge']
    .concat(inputPaths)
    .concat(['--output-path', outputPath])
  const options = {
    silent: true
  }

  await exec.exec('xcrun', args, options)
}
