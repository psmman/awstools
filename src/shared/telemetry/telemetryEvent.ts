/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

import { MetadataEntry, MetricDatum, Unit } from './clienttelemetry'

const NAME_ILLEGAL_CHARS_REGEX = new RegExp('[^\\w+-.:_]', 'g')

export interface Datum {
    name: string
    value: number
    unit?: Unit
    metadata?: Map<string, string>
}

export interface TelemetryEvent {
    namespace: string
    createTime: Date
    data?: Datum[]
}

export function toMetricData(array: TelemetryEvent[]): MetricDatum[] {
    return ([] as MetricDatum[]).concat(
        ...array.map( metricEvent => {
            if (metricEvent.data !== undefined) {
                const mappedEventData = metricEvent.data.map( datum => {
                    let metadata: MetadataEntry[] | undefined
                    let unit = datum.unit

                    if (datum.metadata !== undefined) {
                        metadata = Array.from(datum.metadata).map(entry => {
                            return { Key: entry[0], Value: entry[1] }
                        })
                    }

                    if (unit === undefined) {
                        unit = 'None'
                    }

                    return {
                        MetricName: `${metricEvent.namespace}_${datum.name}`.replace(NAME_ILLEGAL_CHARS_REGEX, ''),
                        EpochTimestamp: metricEvent.createTime.getTime(),
                        Unit: unit,
                        Value: datum.value,
                        Metadata: metadata
                    }
                })

                return mappedEventData
            }

            // case where there are no datum attached to the event, but we should still publish this
            return {
                MetricName: metricEvent.namespace.replace(NAME_ILLEGAL_CHARS_REGEX, ''),
                EpochTimestamp: metricEvent.createTime.getTime(),
                Unit: 'None',
                Value: 0
            }
        })
    )
}
