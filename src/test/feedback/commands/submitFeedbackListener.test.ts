/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { anything, deepEqual, instance, mock, verify, when } from 'ts-mockito'
import { FeedbackPanel, submitFeedbackListener, Window } from '../../../feedback/commands/submitFeedbackListener'
import { TelemetryService } from '../../../shared/telemetry/telemetryService'

const COMMENT = 'comment'
const SENTIMENT = 'Positive'
const message = { command: 'submitFeedback', comment: COMMENT, sentiment: SENTIMENT }

describe('submitFeedbackListener', () => {
    let panel: FeedbackPanel
    let mockPanel: FeedbackPanel

    let window: Window
    let mockWindow: Window

    let telemetry: TelemetryService
    let mockTelemetry: TelemetryService

    beforeEach(async () => {
        mockPanel = mock()
        panel = instance(mockPanel)

        mockWindow = mock()
        window = instance(mockWindow)

        mockTelemetry = mock()
        telemetry = instance(mockTelemetry)
    })

    it('submits feedback, disposes, and shows message on success', async () => {
        const listener = submitFeedbackListener(panel, window, telemetry)
        await listener(message)

        verify(mockTelemetry.postFeedback(deepEqual({ comment: COMMENT, sentiment: SENTIMENT }))).once()
        verify(mockPanel.dispose()).once()
        verify(mockWindow.showInformationMessage('Thanks for the feedback!')).once()
    })

    it('submits feedback and posts failure message on failure', async () => {
        const error = 'Expected failure'

        // tslint:disable-next-line: no-unsafe-any
        when(mockTelemetry.postFeedback(anything())).thenThrow(new Error(error))

        const listener = submitFeedbackListener(panel, window, telemetry)
        await listener(message)

        verify(mockPanel.postMessage(deepEqual({ statusCode: 'Failure', error: error }))).once()
    })
})
