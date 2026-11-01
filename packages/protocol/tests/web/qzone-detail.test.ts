import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneMsgDetail } from '@snowluma/protocol/web/qzone';
import { getQzonePublicComments } from '@snowluma/protocol/web/qzone-public';
import type { JsonObject } from '@snowluma/common/json';
import { RequestUtil, getBknFromCookie } from '@snowluma/protocol/web/request-util';

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000' };
// Synthetic tid: author 10001 and timestamp 1700000000, both little-endian.
const tid = '1127000000f1536500000000';
const authorUin = 10001;
const ugcId = 'CLcCEJFOGIDiz6oGIgAqADIBMEIYMTEyNzAwMDAwMGYxNTM2NTAwMDAwMDAw';

const reply = {
    id: '1',
    user: { uin: '10000', nick: 'Bot' },
    time: '1700000002',
    content: [{ type: 0, content: 'Thanks!' }],
    replys: [],
};
const comment = {
    id: '3',
    user: { uin: '20002', nick: 'Reader' },
    time: '1700000001',
    content: [
        { type: 0, content: 'Hello\n' },
        { type: 0, content: '[em]e10319[/em]' },
    ],
    replys: [reply],
};

function page(
    comments: unknown[],
    extra: { has_more?: unknown; attach_info?: unknown } = {},
): Record<string, unknown> {
    return {
        retcode: 0,
        data: {
            feed: {
                feed: {
                    cell_common: { feed_id: tid, union_id: { feed_id: tid, ugc_id: ugcId } },
                    cell_summary: { summary: [{ type: 0, content: 'Post' }] },
                    cell_comment: {
                        num: Array.isArray(comments) ? comments.length : 0,
                        comments,
                    },
                },
            },
            has_more: 'has_more' in extra ? extra.has_more : false,
            attach_info: 'attach_info' in extra ? extra.attach_info : 'next-page',
            extra_streams: [],
            comment_load_mode: 0,
        },
        message: '',
    };
}

describe('qzone / getQzoneMsgDetail', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads the feed from the trpc reader and maps comments and replies', async () => {
        const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(page([comment]));
        const result = await getQzoneMsgDetail(cookies, undefined, tid);

        expect(result).toMatchObject({
            tid,
            content: 'Post',
            comment_num: 1,
            comments: [
                {
                    comment_id: '3',
                    uin: 20002,
                    name: 'Reader',
                    time: 1700000001,
                    content: 'Hello\n[em]e10319[/em]',
                    replies: [
                        {
                            comment_id: '1',
                            parent_comment_id: '3',
                            parent_comment_uin: 20002,
                            uin: 10000,
                            name: 'Bot',
                            time: 1700000002,
                            content: 'Thanks!',
                        },
                    ],
                },
            ],
        });

        const [url, method, body, headers] = request.mock.calls[0]!;
        expect(url).toBe(
            `https://h5.qzone.qq.com/http2rpc/gotrpc/v1/trpc.qzone.feeds_reader.FeedsReader/GetFeedDetail?g_tk=${getBknFromCookie(cookies)}`,
        );
        expect(method).toBe('POST');
        expect(body).toEqual({
            union_id: {
                feed_id: tid,
                ugc_id: ugcId,
                adv_id: null,
            },
            feed_action_domain_type: 1,
            from_page: 1,
        });
        expect(headers).toMatchObject({
            Cookie: expect.stringContaining('p_skey=PSK'),
            'Content-Type': 'application/json',
            'x-oidb': JSON.stringify({ uint32_command: '0x97b1', uint32_service_type: '1' }),
        });
    });

    it('passes the upstream data through unchanged alongside the derived fields', async () => {
        const response = page([comment], { attach_info: 'cursor', has_more: false });
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        const result = await getQzoneMsgDetail(cookies, undefined, tid, 0, 20);

        expect(result.attach_info).toBe('cursor');
        expect(result.has_more).toBe(false);
        expect(result.extra_streams).toEqual([]);
        expect(result.comment_load_mode).toBe(0);
        expect(result.feed).toEqual((response.data as Record<string, unknown>).feed);
    });

    it('returns the requested page without paginating when attach_info is given', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValue(page([comment], { attach_info: 'cursor-2' }));
        const result = await getQzoneMsgDetail(cookies, undefined, tid, 5, 10, 'cursor-1');

        expect(result.comments).toHaveLength(1);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0]![2]).toMatchObject({ attach_info: 'cursor-1' });
    });

    it('walks comment pages until pos+num are collected', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValueOnce(page([comment], { attach_info: 'p2', has_more: true }))
            .mockResolvedValueOnce(page([], { attach_info: 'p3', has_more: true }))
            .mockResolvedValueOnce(page([comment], { attach_info: 'p4', has_more: false }));

        const result = await getQzoneMsgDetail(cookies, undefined, tid, 0, 2);

        expect(request).toHaveBeenCalledTimes(3);
        expect(result.comments).toHaveLength(2);
        expect(request.mock.calls[1]![2]).toMatchObject({ attach_info: 'p2' });
        expect(request.mock.calls[2]![2]).toMatchObject({ attach_info: 'p3' });
        expect(result.attach_info).toBe('p4');
    });

    it('applies pos against the collected comments', async () => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValueOnce(
            page([comment, comment, comment], { has_more: false }),
        );
        const result = await getQzoneMsgDetail(cookies, undefined, tid, 1, 1);
        expect(result.comments).toHaveLength(1);
    });

    it('keeps offset reads continuous across partial upstream pages', async () => {
        const first = ['1', '2', '3'].map((id) => ({ ...comment, id }));
        const second = ['4', '5'].map((id) => ({ ...comment, id }));
        vi.spyOn(RequestUtil, 'HttpGetJson').mockImplementation(async (_url, _method, body) =>
            (body as JsonObject).attach_info === 'p2'
                ? page(second, { attach_info: 'end', has_more: false })
                : page(first, { attach_info: 'p2', has_more: true }),
        );

        const ids: string[] = [];
        let pos = 0;

        for (let read = 0; read < 3; read++) {
            const detail = await getQzoneMsgDetail(cookies, undefined, tid, pos, 2);
            ids.push(...detail.comments.map((entry) => entry.comment_id));
            pos += detail.comments.length;
        }

        expect(ids).toEqual(['1', '2', '3', '4', '5']);
    });

    it('continues a sliced final upstream page with pos even when has_more is false', async () => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(
            page(
                ['1', '2', '3'].map((id) => ({ ...comment, id })),
                { has_more: false },
            ),
        );
        const first = await getQzoneMsgDetail(cookies, undefined, tid, 0, 2);
        const last = await getQzoneMsgDetail(cookies, undefined, tid, first.comments.length, 2);

        expect(first.has_more).toBe(false);
        expect([...first.comments, ...last.comments].map((entry) => entry.comment_id)).toEqual([
            '1',
            '2',
            '3',
        ]);
    });

    it('passes the inner feed to the existing public comment reader', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValueOnce(page([comment]))
            .mockResolvedValueOnce({ retcode: 0, data: { comments: [] } });
        const detail = await getQzoneMsgDetail(cookies, undefined, tid);
        const feed = (detail.feed as JsonObject).feed as JsonObject;

        await expect(getQzonePublicComments(cookies, feed, 'cursor')).resolves.toEqual({
            comments: [],
        });
        expect(request.mock.calls[1]![2]).toMatchObject({
            union_id: { feed_id: tid, ugc_id: ugcId },
            attach_info: 'cursor',
        });
    });

    it('preserves a null upstream cursor', async () => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(page([], { attach_info: null }));
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).resolves.toMatchObject({
            attach_info: null,
            comments: [],
        });
    });

    it('accepts a repeated cursor on the final upstream page', async () => {
        vi.spyOn(RequestUtil, 'HttpGetJson')
            .mockResolvedValueOnce(page([comment], { attach_info: 'p2', has_more: true }))
            .mockResolvedValueOnce(page([comment], { attach_info: 'p2', has_more: false }));
        await expect(getQzoneMsgDetail(cookies, undefined, tid, 0, 2)).resolves.toMatchObject({
            comments: expect.any(Array),
            has_more: false,
        });
    });

    it.each([{ has_more: 'true' }, { attach_info: {} }])(
        'rejects malformed paging metadata even when the requested comments fit (%j)',
        async (extra) => {
            vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(page([comment], extra));
            await expect(getQzoneMsgDetail(cookies, undefined, tid, 0, 1)).rejects.toThrow(
                /qzone msg detail/,
            );
        },
    );

    it('rejects a target_uin that does not own the tid', async () => {
        const request = vi.spyOn(RequestUtil, 'HttpGetJson');
        await expect(getQzoneMsgDetail(cookies, '20002', tid)).rejects.toThrow(/not target_uin/);
        expect(request).not.toHaveBeenCalled();

        request.mockResolvedValue(page([], { has_more: false }));
        await expect(getQzoneMsgDetail(cookies, String(authorUin), tid)).resolves.toMatchObject({
            tid,
        });
    });

    it('rejects a tid that is not 24 hex digits before fetching', async () => {
        const request = vi.spyOn(RequestUtil, 'HttpGetJson');
        await expect(getQzoneMsgDetail(cookies, undefined, 'T1')).rejects.toThrow(/24 位十六进制/);
        expect(request).not.toHaveBeenCalled();
    });

    it('rejects a page whose feed_id does not match the requested tid', async () => {
        const response = page([comment]);
        const data = response.data as Record<string, unknown>;
        (data.feed as Record<string, Record<string, unknown>>).feed!.cell_common = {
            feed_id: '000000000000000000000000',
        };
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).rejects.toThrow(
            /feed_id does not match/,
        );
    });

    it('refuses to loop when paging does not advance', async () => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(
            page([comment], { attach_info: 'same', has_more: true }),
        );
        await expect(getQzoneMsgDetail(cookies, undefined, tid, 0, 50)).rejects.toThrow(
            /did not advance/,
        );
    });

    it.each([
        { retcode: 1, message: 'denied' },
        { retcode: 0, data: null },
        { retcode: 0, data: { feed: null, has_more: false } },
        {
            retcode: 0,
            data: { feed: { feed: { cell_common: { feed_id: tid } } }, has_more: false },
        },
    ])('propagates a rejected upstream response (%j)', async (response) => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).rejects.toThrow(/qzone/);
    });

    it.each([
        [{ ...comment, user: { uin: 'bad', nick: 'Reader' } }],
        [{ ...comment, id: {} }],
        [{ ...comment, time: 'yesterday' }],
        [{ ...comment, replys: {} }],
    ])('rejects malformed comment data instead of returning an empty success (%#)', async (c) => {
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(page(c));
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).rejects.toThrow(
            /qzone msg detail/,
        );
    });

    it.each([[undefined], [null], [[]]])('accepts an empty comment page (%j)', async (comments) => {
        const response = page([] as unknown[], { has_more: false });
        const data = response.data as Record<string, unknown>;
        (data.feed as Record<string, Record<string, unknown>>).feed!.cell_comment = {
            num: 0,
            comments,
        };
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).resolves.toMatchObject({
            comment_num: 0,
            comments: [],
        });
    });

    it('treats a missing cell_summary as empty content', async () => {
        const response = page([], { has_more: false });
        const data = response.data as Record<string, unknown>;
        delete (data.feed as Record<string, Record<string, unknown>>).feed!.cell_summary;
        vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response);
        await expect(getQzoneMsgDetail(cookies, undefined, tid)).resolves.toMatchObject({
            content: '',
            comment_num: 0,
            comments: [],
        });
    });
});
