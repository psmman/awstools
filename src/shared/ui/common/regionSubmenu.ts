/*!
 * Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../extensionGlobals'
import { isValidResponse, StepEstimator } from '../../wizards/wizard'
import { createQuickPick, ExtendedQuickPickOptions, ItemLoadTypes } from '../pickerPrompter'
import { Prompter, PromptResult } from '../prompter'
import { createRegionPrompter } from './region'

const switchRegion = Symbol('switchRegion')

export interface RegionSubmenuResponse<T> {
    readonly region: string
    readonly data: T
}

export class RegionSubmenu<T> extends Prompter<RegionSubmenuResponse<T>> {
    private currentState: 'data' | 'region' = 'data'
    private steps?: [current: number, total: number]

    public constructor(
        private readonly itemsProvider: (region: string) => ItemLoadTypes<T>,
        private readonly options?: ExtendedQuickPickOptions<T>,
        private currentRegion = globals.awsContext.guessDefaultRegion()
    ) {
        super()
    }

    public get menuPrompter() {
        return createQuickPick<T | typeof switchRegion>(
            this.itemsProvider(this.currentRegion),
            this.options as ExtendedQuickPickOptions<T | typeof switchRegion>
        )
    }

    public get regionPrompter() {
        return createRegionPrompter(undefined, { defaultRegion: this.currentRegion })
    }

    protected async promptUser(): Promise<PromptResult<RegionSubmenuResponse<T>>> {
        while (true) {
            switch (this.currentState) {
                case 'data': {
                    const prompter = this.menuPrompter

                    prompter.quickPick.items = [
                        {
                            label: 'Switch region',
                            data: switchRegion,
                            detail: `Showing groups for ${this.currentRegion}`,
                        },
                        ...prompter.quickPick.items,
                    ]

                    this.steps && prompter.setSteps(this.steps[0], this.steps[1])

                    const resp = await prompter.prompt()
                    if (resp === switchRegion) {
                        this.currentState = 'region'
                    } else if (isValidResponse(resp)) {
                        return { region: this.currentRegion, data: resp }
                    } else {
                        return resp
                    }

                    break
                }
                case 'region': {
                    const prompter = this.regionPrompter
                    const resp = await prompter.prompt()

                    if (isValidResponse(resp)) {
                        this.currentRegion = resp.id
                    }

                    this.currentState = 'data'

                    break
                }
            }
        }
    }

    public setSteps(current: number, total: number): void {
        this.steps = [current, total]
    }

    // Unused
    public get recentItem(): any {
        return
    }

    public set recentItem(response: any) {}
    public setStepEstimator(estimator: StepEstimator<RegionSubmenuResponse<T>>): void {}
}
