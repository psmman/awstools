/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import { workspace, WorkspaceEdit } from 'vscode'
import { isCloud9 } from '../../shared/extensionUtilities'
import * as CodeWhispererConstants from '../models/constants'

interface bracketMapType {
    [k: string]: string
}

const quotes = ["'", '"', '`']
const parenthesis = ['(', '[', '{', ')', ']', '}', '<', '>']

const closeToOpenParen: bracketMapType = {
    ')': '(',
    ']': '[',
    '}': '{',
    '>': '<',
}

const openToCloseParen: bracketMapType = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
}

/**
 * @param endPosition: end position of the recommendation
 * @param startPosition: start position of the recommendation
 */
export async function handleExtraBrackets(
    editor: vscode.TextEditor,
    recommendation: string,
    endPosition: vscode.Position,
    startPosition: vscode.Position
) {
    const endOffset = editor.document.offsetAt(endPosition)
    const startOffset = editor.document.offsetAt(startPosition)
    const leftContext = editor.document.getText(
        new vscode.Range(
            startPosition,
            editor.document.positionAt(Math.max(startOffset - CodeWhispererConstants.charactersLimit, 0))
        )
    )

    const rightContext = editor.document.getText(
        new vscode.Range(
            editor.document.positionAt(endOffset),
            editor.document.positionAt(endOffset + CodeWhispererConstants.charactersLimit)
        )
    )
    const bracketsToRemove = getBracketsToRemove(
        editor,
        recommendation,
        leftContext,
        rightContext,
        endPosition,
        startPosition
    )

    const quotesToRemove = getQuotesToRemove(
        editor,
        recommendation,
        leftContext,
        rightContext,
        endPosition,
        startPosition
    )

    const symbolsToRemove = [...bracketsToRemove, ...quotesToRemove]

    if (symbolsToRemove.length) {
        await removeBracketsFromRightContext(editor, symbolsToRemove, endPosition)
    }
}

const removeBracketsFromRightContext = async (
    editor: vscode.TextEditor,
    idxToRemove: number[],
    endPosition: vscode.Position
) => {
    const offset = editor.document.offsetAt(endPosition)

    if (isCloud9()) {
        const edits = idxToRemove.map(idx => ({
            range: new vscode.Range(
                editor.document.positionAt(offset + idx),
                editor.document.positionAt(offset + idx + 1)
            ),
            newText: '',
        }))
        const wEdit = new WorkspaceEdit()
        wEdit.set(editor.document.uri, [...edits])
        await workspace.applyEdit(wEdit)
    } else {
        await editor.edit(
            editBuilder => {
                idxToRemove.forEach(idx => {
                    const range = new vscode.Range(
                        editor.document.positionAt(offset + idx),
                        editor.document.positionAt(offset + idx + 1)
                    )
                    editBuilder.delete(range)
                })
            },
            { undoStopAfter: false, undoStopBefore: false }
        )
    }
}

function getBracketsToRemove(
    editor: vscode.TextEditor,
    recommendation: string,
    leftContext: string,
    rightContext: string,
    end: vscode.Position,
    start: vscode.Position
) {
    const unpairedClosingsInReco = nonClosedClosingParen(recommendation)
    const unpairedOpeningsInLeftContext = nonClosedOpneingParen(leftContext, unpairedClosingsInReco.length)
    const unpairedClosingsInRightContext = nonClosedClosingParen(rightContext)

    let lastNonSpaceCharInReco: string | undefined = undefined
    for (let i = recommendation.length - 1; i >= 0; i--) {
        const char = recommendation[i]
        if (!/\s/.test(char)) {
            lastNonSpaceCharInReco = char
            break
        }
    }

    const toRemove: number[] = []

    let i = 0
    let j = 0
    let k = 0
    while (i < unpairedOpeningsInLeftContext.length && j < unpairedClosingsInReco.length) {
        const opening = unpairedOpeningsInLeftContext[i]
        const closing = unpairedClosingsInReco[j]

        const isPaired = closeToOpenParen[closing.char] === opening.char
        const toDelete = unpairedClosingsInRightContext[k]

        if (isPaired) {
            if (toDelete && toDelete.char === closing.char) {
                if (lastNonSpaceCharInReco !== undefined && parenthesis.includes(lastNonSpaceCharInReco)) {
                    toRemove.push(toDelete.strOffset)
                }

                k++
            }
        }

        i++
        j++
    }

    return toRemove
}

// best effort to guess quotes since it's hard to differentiate opening from closing
function getQuotesToRemove(
    editor: vscode.TextEditor,
    recommendation: string,
    leftContext: string,
    rightContext: string,
    endPosition: vscode.Position,
    startPosition: vscode.Position
) {
    let leftQuote: string | undefined = undefined
    let leftIndex: number | undefined = undefined
    for (let i = leftContext.length - 1; i >= 0; i--) {
        const char = leftContext[i]
        if (quotes.includes(char)) {
            leftQuote = char
            leftIndex = leftContext.length - i
            break
        }
    }

    let rightQuote: string | undefined = undefined
    let rightIndex: number | undefined = undefined
    for (let i = 0; i < rightContext.length; i++) {
        const char = rightContext[i]
        if (quotes.includes(char)) {
            rightQuote = char
            rightIndex = i
            break
        }
    }

    let quoteCountInReco = 0
    if (leftQuote && rightQuote && leftQuote === rightQuote) {
        for (const char of recommendation) {
            if (quotes.includes(char) && char === leftQuote) {
                quoteCountInReco++
            }
        }
    }

    if (leftIndex !== undefined && rightIndex !== undefined && quoteCountInReco % 2 !== 0) {
        const p = editor.document.positionAt(editor.document.offsetAt(endPosition) + rightIndex)

        if (endPosition.line === startPosition.line && endPosition.line === p.line) {
            return [rightIndex]
        }
    }

    return []
}

function nonClosedOpneingParen(str: string, cnt?: number): { char: string; strOffset: number }[] {
    const resultSet: { char: string; strOffset: number }[] = []
    const stack: string[] = []

    for (let i = str.length - 1; i >= 0; i--) {
        const char = str[i]
        if (char! in parenthesis) {
            continue
        }

        if (char in closeToOpenParen) {
            stack.push(char)
            if (cnt && cnt === resultSet.length) {
                return resultSet
            }
        } else if (char in openToCloseParen) {
            if (stack.length !== 0 && stack[stack.length - 1] === openToCloseParen[char]) {
                stack.pop()
            } else {
                resultSet.push({ char: char, strOffset: i })
            }
        }
    }

    return resultSet
}

function nonClosedClosingParen(str: string, cnt?: number): { char: string; strOffset: number }[] {
    const resultSet: { char: string; strOffset: number }[] = []
    const stack: string[] = []

    for (let i = 0; i < str.length; i++) {
        const char = str[i]
        if (char! in parenthesis) {
            continue
        }

        if (char in openToCloseParen) {
            stack.push(char)
            if (cnt && cnt === resultSet.length) {
                return resultSet
            }
        } else if (char in closeToOpenParen) {
            if (stack.length !== 0 && stack[stack.length - 1] === closeToOpenParen[char]) {
                stack.pop()
            } else {
                resultSet.push({ char: char, strOffset: i })
            }
        }
    }

    return resultSet
}
