/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'
import { ExtContext } from '../../shared/extensions'

import { getLogger } from '../../shared/logger'
import * as telemetry from '../../shared/telemetry/telemetry'
import * as vscode from 'vscode'
import { TelemetryService } from '../../shared/telemetry/telemetryService'
import { localize } from '../../shared/utilities/vsCodeUtils'
import { VueWebview, VueWebviewPanel } from '../../webviews/main'

export interface FeedbackMessage {
    comment: string
    sentiment: string
}

export class FeedbackWebview extends VueWebview {
    public readonly id = 'submitFeedback'
    public readonly source = 'feedbackVue.js'
    public readonly title = localize('AWS.submitFeedback.title', 'Send Feedback')

    public constructor(private readonly telemetry: TelemetryService) {
        super()
    }

    public async submit(message: FeedbackMessage): Promise<string | void> {
        const logger = getLogger()
        logger.info(`Submitting ${message.sentiment} feedback`)

        try {
            await this.telemetry.postFeedback({
                comment: message.comment,
                sentiment: message.sentiment,
            })
        } catch (err) {
            const errorMessage = (err as Error).message || 'Failed to submit feedback'
            logger.error(`Failed to submit ${message.sentiment} feedback: ${errorMessage}`)

            telemetry.recordFeedbackResult({ result: 'Failed' })

            return errorMessage
        }

        logger.info(`Successfully submitted ${message.sentiment} feedback`)

        telemetry.recordFeedbackResult({ result: 'Succeeded' })

        this.dispose()

        vscode.window.showInformationMessage(
            localize('AWS.message.info.submitFeedback.success', 'Thanks for the feedback!')
        )
    }
}

const Server = VueWebview.compilePanel(FeedbackWebview)

let activeWebview: VueWebviewPanel | undefined

export async function submitFeedback(context: ExtContext) {
    if (!activeWebview) {
        activeWebview = new Server(context, globals.telemetry)
        activeWebview.server.onDidDispose(() => (activeWebview = undefined))
    }

    await activeWebview.show({ cssFiles: ['submitFeedback.css'] })
}
