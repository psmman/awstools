/*!
 * Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode'
import * as telemetry from '../../shared/telemetry/telemetry'
import {
    CloudWatchLogsData,
    CloudWatchLogsGroupInfo,
    CloudWatchLogsParameters,
    LogStreamRegistry,
    filterLogEventsFromUriComponents,
} from '../registry/logStreamRegistry'
import { DataQuickPickItem } from '../../shared/ui/pickerPrompter'
import { Wizard } from '../../shared/wizards/wizard'
import { createInputBox, InputBoxPrompter } from '../../shared/ui/inputPrompter'
import { createURIFromArgs } from '../cloudWatchLogsUtils'
import { DefaultCloudWatchLogsClient } from '../../shared/clients/cloudWatchLogsClient'
import { CloudWatchLogs } from 'aws-sdk'
import { RegionSubmenu, RegionSubmenuResponse } from '../../shared/ui/common/regionSubmenu'
import { integer } from 'aws-sdk/clients/cloudfront'
import { Prompter, PromptResult } from '../../shared/ui/prompter'
import { createQuickPick, QuickPickPrompter } from '../../shared/ui/pickerPrompter'
import { ItemLoadTypes } from '../../shared/ui/pickerPrompter'
import { isValidResponse } from '../../shared/wizards/wizard'
import { StepEstimator } from '../../shared/wizards/wizard'
import { highlightDocument } from '../document/logStreamDocumentProvider'
import { CancellationError } from '../../shared/utilities/timeoutUtils'
import { localize } from 'vscode-nls'
import { getLogger } from '../../shared/logger'

export async function searchLogGroup(registry: LogStreamRegistry): Promise<void> {
    let result: telemetry.Result = 'Succeeded'
    const response = await new SearchLogGroupWizard().run()
    if (response) {
        const logGroupInfo: CloudWatchLogsGroupInfo = {
            groupName: response.submenuResponse.data,
            regionName: response.submenuResponse.region,
        }
        let parameters: CloudWatchLogsParameters

        if (response.timeRange.start === response.timeRange.end) {
            // this means no time filter.
            parameters = {
                limit: registry.configuration.get('limit', 10000),
                filterPattern: response.filterPattern,
            }
        } else {
            parameters = {
                limit: registry.configuration.get('limit', 10000),
                filterPattern: response.filterPattern,
                startTime: response.timeRange.start,
                endTime: response.timeRange.end,
            }
        }

        const uri = createURIFromArgs(logGroupInfo, parameters)
        const initialStreamData: CloudWatchLogsData = {
            data: [],
            parameters: parameters,
            busy: false,
            logGroupInfo: logGroupInfo,
            retrieveLogsFunction: filterLogEventsFromUriComponents,
        }
        // Currently displays nothing if update log fails in non-cancellationError. (don't want this)

        try {
            await registry.registerLog(uri, initialStreamData)
            const doc = await vscode.workspace.openTextDocument(uri) // calls back into the provider
            vscode.languages.setTextDocumentLanguage(doc, 'log')
            const textEditor = await vscode.window.showTextDocument(doc, { preview: false })
            registry.setTextEditor(uri, textEditor)
            highlightDocument(registry, uri)
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
                if (event.document.uri.toString() === doc.uri.toString()) {
                    highlightDocument(registry, uri)
                }
            })
        } catch (err) {
            if (CancellationError.isUserCancelled(err)) {
                getLogger().debug('cwl: User Cancelled Search')
                result = 'Failed'
            } else {
                const error = err as Error
                vscode.window.showErrorMessage(
                    localize(
                        'AWS.cwl.searchLogGroup.errorRetrievingLogs',
                        'Error retrieving logs for Log Group {0} : {1}',
                        logGroupInfo.groupName,
                        error.message
                    )
                )
            }
        }
    } else {
        result = 'Cancelled'
    }
    telemetry.recordCloudwatchlogsOpenStream({ result })
}

async function getLogGroupsFromRegion(regionCode: string): Promise<DataQuickPickItem<string>[]> {
    const client = new DefaultCloudWatchLogsClient(regionCode)
    const logGroups = await logGroupsToArray(client.describeLogGroups())
    const options = logGroups.map<DataQuickPickItem<string>>(logGroupString => ({
        label: logGroupString,
        data: logGroupString,
    }))
    return options
}

async function logGroupsToArray(logGroups: AsyncIterableIterator<CloudWatchLogs.LogGroup>): Promise<string[]> {
    const logGroupsArray = []
    for await (const logGroupObject of logGroups) {
        logGroupObject.logGroupName && logGroupsArray.push(logGroupObject.logGroupName)
    }
    return logGroupsArray
}

export function createFilterpatternPrompter() {
    return createInputBox({
        title: 'Keyword Search',
        placeholder: 'Enter text here',
    })
}

export function createRegionSubmenu() {
    return new RegionSubmenu(getLogGroupsFromRegion)
}

export interface SearchLogGroupWizardResponse {
    submenuResponse: RegionSubmenuResponse<string>
    filterPattern: string
    timeRange: TimeFilterResponse
}

export class SearchLogGroupWizard extends Wizard<SearchLogGroupWizardResponse> {
    public constructor() {
        super()
        this.form.submenuResponse.bindPrompter(createRegionSubmenu)
        this.form.filterPattern.bindPrompter(createFilterpatternPrompter)
        this.form.timeRange.bindPrompter(() => new TimeFilterSubmenu())
    }
}

export interface TimeFilterResponse {
    // # of miliseconds since january 1 1970 since thats what API expects.
    readonly start: number
    readonly end: number
}

const customRange = Symbol('customRange')

export class TimeFilterSubmenu extends Prompter<TimeFilterResponse> {
    // TODO: Generalize submenu code between this and the region Submenu.
    private currentState: 'custom-range' | 'recent-range' = 'recent-range'
    private steps?: [current: number, total: number]
    public defaultPrompter: QuickPickPrompter<typeof customRange | integer> = this.createMenuPrompter()
    public customPrompter: InputBoxPrompter = this.createDateBox()

    public constructor() {
        super()
    }

    private get recentTimeOptions(): ItemLoadTypes<integer> {
        const options: DataQuickPickItem<integer>[] = []
        options.push({
            label: 'View all events',
            data: 0,
        })
        options.push({
            label: 'Last 1 Minute',
            data: 1,
        })
        options.push({
            label: 'Last 30 Minutes',
            data: 30,
        })
        options.push({
            label: 'Last 1 Hour',
            data: 60,
        })
        options.push({
            label: 'Last 12 Hours',
            data: 60 * 12,
        })
        return options
    }

    public createMenuPrompter() {
        const prompter = createQuickPick<integer | typeof customRange>(this.recentTimeOptions)

        prompter.quickPick.items = [
            ...prompter.quickPick.items,
            {
                label: 'Custom time range',
                data: customRange,
                detail: `YYYY/MM/DD-YYYY/MM/DD`,
            },
        ]

        return prompter
    }

    private switchState(newState: 'custom-range' | 'recent-range') {
        this.currentState = newState
    }

    public createDateBox(): InputBoxPrompter {
        return createInputBox({
            title: 'Enter custom date range',
            placeholder: 'YYYY/MM/DD-YYYY/MM/DD',
            validateInput: input => this.validateDate(input),
        })
    }

    protected async promptUser(): Promise<PromptResult<TimeFilterResponse>> {
        while (true) {
            switch (this.currentState) {
                case 'recent-range': {
                    this.steps && this.defaultPrompter.setSteps(this.steps[0], this.steps[1])

                    const resp = await this.defaultPrompter.prompt()
                    if (resp === customRange) {
                        this.switchState('custom-range')
                    } else if (isValidResponse(resp)) {
                        const [endTime, startTime] = [new Date(), new Date()]
                        startTime.setHours(endTime.getHours() - resp)

                        return { start: startTime.valueOf(), end: endTime.valueOf() }
                    } else {
                        return resp
                    }

                    break
                }
                case 'custom-range': {
                    const resp = await this.customPrompter.prompt()
                    if (isValidResponse(resp)) {
                        const [startTime, endTime] = this.parseDate(resp)

                        return { start: startTime.valueOf(), end: endTime.valueOf() }
                    }

                    this.switchState('recent-range')

                    break
                }
            }
        }
    }

    public validateDate(input: string) {
        const parts = input.split('-')
        const today = new Date()

        if (parts.length !== 2) {
            return 'String must include two dates seperated by `-`'
        }
        const [startTime, endTime] = parts

        if (!Date.parse(startTime)) {
            return 'starting time format is invalid, use YYYY/MM/DD'
        }
        if (!Date.parse(endTime)) {
            return 'ending time format is valid, use YYYY/MM/DD'
        }
        const regEx = /^\d{4}\/\d{2}\/\d{2}$/
        if (!startTime.match(regEx) || !endTime.match(regEx)) {
            return 'enter date in format YYYY/MM/DD-YYYY/MM/DD'
        }
        if (startTime === endTime) {
            return 'must enter two different dates for valid range'
        }
        if (Date.parse(startTime) > Date.parse(endTime)) {
            return 'first date must occur before second date'
        }

        if (Date.parse(endTime) > today.valueOf()) {
            return 'end date cannot be in the future'
        }
    }

    public setSteps(current: number, total: number): void {
        this.steps = [current, total]
    }

    private parseDate(resp: string) {
        const parts = resp.split('-')
        return [new Date(parts[0]), new Date(parts[1])]
    }

    // Unused
    public get recentItem(): any {
        return
    }

    public set recentItem(response: any) {}
    public setStepEstimator(estimator: StepEstimator<TimeFilterResponse>): void {}
}
