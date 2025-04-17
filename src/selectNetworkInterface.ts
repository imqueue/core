/*!
 * Broadcast network interface selection algorithm
 *
 * Copyright (c) 2025, imqueue.com <support@imqueue.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */
import * as os from 'os';

export function selectNetworkInterface(options: {
    broadcastAddress?: string;
    limitedBroadcastAddress?: string;
}): string {
    const networkInterfaces = os.networkInterfaces();
    const limitedBroadcastAddress = options.limitedBroadcastAddress;
    const broadcastAddress = options.broadcastAddress
        || limitedBroadcastAddress;
    const defaultAddress = '0.0.0.0';

    if (!broadcastAddress) {
        return defaultAddress;
    }

    const equalAddresses = broadcastAddress === limitedBroadcastAddress;

    if (equalAddresses) {
        return defaultAddress;
    }

    for (const key in networkInterfaces) {
        if (!networkInterfaces[key]) {
            continue;
        }

        for (const net of networkInterfaces[key]) {
            const shouldBeSelected = net.family === 'IPv4'
                && net.address.startsWith(
                    broadcastAddress.replace(/\.255/g, ''),
                );

            if (shouldBeSelected) {
                return net.address;
            }
        }
    }

    return defaultAddress;
}
