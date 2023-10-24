/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { AggregatedCodeScanIssue, CodeScanIssue } from '../models/model'
import globals from '../../shared/extensionGlobals'

export class SecurityIssueHoverProvider implements vscode.HoverProvider {
    static #instance: SecurityIssueHoverProvider
    private _issues: AggregatedCodeScanIssue[] = []

    public static get instance() {
        return (this.#instance ??= new this())
    }

    public set issues(issues: AggregatedCodeScanIssue[]) {
        this._issues = issues
    }

    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.Hover {
        const contents: vscode.MarkdownString[] = []

        for (const group of this._issues) {
            if (document.fileName !== group.filePath) {
                continue
            }

            for (const issue of group.issues) {
                const range = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                if (range.contains(position)) {
                    contents.push(this._getContent(issue))
                }
            }
        }

        return new vscode.Hover(contents)
    }

    /**
     * Handles the position of each hover when the text document is changed.
     * Any issues that intersect with the changed range will be removed and any change that
     * happens above an issue will offset its start and end lines.
     *
     * @param event Event that triggered the text document change
     */
    public handleDocumentChange(event: vscode.TextDocumentChangeEvent) {
        const changedRange = event.contentChanges[0].range
        const changedText = event.contentChanges[0].text
        const lineOffset = this._getLineOffset(changedRange, changedText)

        this._issues = this._issues.map(group => {
            if (group.filePath !== event.document.fileName) {
                return group
            }
            return {
                ...group,
                issues: group.issues
                    .filter(issue => {
                        const range = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                        const intersection = changedRange.intersection(range)
                        return !(intersection && (/\S/.test(changedText) || changedText === ''))
                    })
                    .map(issue => {
                        const range = new vscode.Range(issue.startLine, 0, issue.endLine, 0)
                        if (range.start.line < changedRange.end.line) {
                            return issue
                        }
                        return {
                            ...issue,
                            startLine: issue.startLine + lineOffset,
                            endLine: issue.endLine + lineOffset,
                        }
                    }),
            }
        })
    }

    private _getLineOffset(range: vscode.Range, text: string) {
        const originLines = range.end.line - range.start.line + 1
        const changedLines = text.split('\n').length
        return changedLines - originLines
    }

    private _getContent(issue: CodeScanIssue) {
        const markdownString = new vscode.MarkdownString()
        markdownString.isTrusted = true
        markdownString.supportHtml = true
        markdownString.supportThemeIcons = true

        const [suggestedFix] = issue.remediation.suggestedFixes

        if (suggestedFix) {
            markdownString.appendMarkdown(
                `## Suggested Fix for ${issue.title} ${this._makeSeverityBadge(issue.severity)}\n`
            )
        } else {
            markdownString.appendMarkdown(`## ${issue.title} ${this._makeSeverityBadge(issue.severity)}\n`)
        }

        markdownString.appendMarkdown(`${issue.description.markdown}\n\n`)

        const viewDetailsCommand = vscode.Uri.parse(
            `command:aws.codeWhisperer.openSecurityIssuePanel?${encodeURIComponent(JSON.stringify(issue))}`
        )
        const applyFixCommand = vscode.Uri.parse('command:aws.codeWhisperer.applySecurityFix')
        markdownString.appendMarkdown(`[$(eye) View Details](${viewDetailsCommand} "Open security issue")\n`)

        if (suggestedFix) {
            markdownString.appendMarkdown(` | [$(wrench) Apply Fix](${applyFixCommand} "Apply suggested fix")\n`)
            markdownString.appendMarkdown(
                `${this._makeCodeBlock(suggestedFix.code, issue.detectorId.split('/').shift())}\n`
            )
        }

        return markdownString
    }

    private _makeSeverityBadge(severity: string) {
        if (!severity) {
            return ''
        }
        return `![${severity}](${vscode.Uri.joinPath(
            globals.context.extensionUri,
            `src/codewhisperer/images/severity-${severity.toLowerCase()}.svg`
        )})`
    }

    /**
     * Creates a markdown string to render a code diff block for a given code block. Lines
     * that are highlighted red indicate deletion while lines highlighted in green indicate
     * addition. An optional language can be provided for syntax highlighting on lines which are
     * not additions or deletions.
     *
     * @param code The code containing the diff
     * @param language The language for syntax highlighting
     * @returns The markdown string
     */
    private _makeCodeBlock(code: string, language?: string) {
        const lines = code.split('\n').slice(1) // Ignore the first line for diff header
        const maxLineChars = lines.reduce((acc, curr) => Math.max(acc, curr.length), 0)
        const paddedLines = lines.map(line => line.padEnd(maxLineChars + 2))

        // Group the lines into sections so consecutive lines of the same type can be placed in
        // the same span below
        const sections = [paddedLines[0]]
        let i = 1
        while (i < paddedLines.length) {
            if (paddedLines[i][0] === sections[sections.length - 1][0]) {
                sections[sections.length - 1] += '\n' + paddedLines[i]
            } else {
                sections.push(paddedLines[i])
            }
            i++
        }

        // Return each section with the correct syntax highlighting and background color
        return sections
            .map(
                section => `
<span class="codicon codicon-none" style="background-color:var(${
                    section.startsWith('-')
                        ? '--vscode-diffEditor-removedTextBackground'
                        : section.startsWith('+')
                        ? '--vscode-diffEditor-insertedTextBackground'
                        : '--vscode-textCodeBlock-background'
                });">

\`\`\`${section.startsWith('-') || section.startsWith('+') ? 'diff' : language}
${section}
\`\`\`

</span>
`
            )
            .join('<br />')
    }
}
