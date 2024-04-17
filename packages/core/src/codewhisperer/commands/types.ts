/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExtStartUpSource } from '../../shared/telemetry'
import { CompositeKey, Commands, vscodeComponent } from '../../shared/vscode/commands2'

/** Indicates a CodeWhisperer command was executed through a tree node */
export const cwTreeNodeSource = 'codewhispererTreeNode'
/** Indicates a CodeWhisperer command was executed through a quick pick item */
export const cwQuickPickSource = 'codewhispererQuickPick'
/** Indicates a CodeWhisperer command was executed through the Amazon Q chat pane */
export const amazonQChatSource = 'amazonQChat'
/** Indicates a CodeWhisperer command was executed during the first start of the extension */
export const firstStartUpSource = ExtStartUpSource.FirstStartUp
/** Indicates a CodeWhisperer command was executed as a result of signing out */
export const cwSignOut = 'codewhispererSignOut'

/**
 * Indicates what caused the CodeWhisperer command to be executed, since a command can be executed from different "sources"
 *
 * This source is mainly used for telemetry purposes, setting the `source` field in the command execution metric.
 *
 * **This is typically used in conjunction with {@link CompositeKey} and {@link Commands} even though
 * the value may not be explicitly used.**
 */
export type CodeWhispererSource =
    | typeof cwQuickPickSource
    | typeof cwTreeNodeSource
    | typeof vscodeComponent
    | typeof amazonQChatSource
    | typeof firstStartUpSource
    | typeof cwSignOut
