import { ChatBarButton, type ChatBarButtonFactory } from '@api/ChatButtons';
import { definePluginSettings } from '@api/Settings';
import definePlugin, { type IconProps, OptionType } from '@utils/types';
import { DraftType, React, SelectedChannelStore, showToast, UploadHandler } from '@webpack/common';
import { bindMessage } from './message.mjs';
import { decodeFile, encodeFile } from './media.mjs';

const settings = definePluginSettings({
    salt: { type: OptionType.STRING, description: '与收发双方使用相同的 MoeGuard 盐值；默认留空。', default: '' }
});

function Icon({ width = 24, height = 24, className }: IconProps) {
    return <svg viewBox="0 0 24 24" width={width} height={height} className={className} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m4 17 5-6 4 4 3-3 4 5"/><circle cx="16" cy="9" r="1.4"/></svg>;
}

const Tools: ChatBarButtonFactory = ({ channel, isMainChat, disabled, type }) => {
    const input = React.useRef<HTMLInputElement>(null);
    const mode = React.useRef<'encode' | 'decode'>('encode');
    const generation = React.useRef(0);
    const busy = React.useRef(false);
    const available = isMainChat && !disabled && type.attachments;
    React.useLayoutEffect(() => {
        busy.current = false;
        return () => { ++generation.current; };
    }, [channel.id, available]);
    if (!available) return null;
    const pick = (action: 'encode' | 'decode') => {
        if (!input.current || busy.current) return;
        mode.current = action;
        input.current.accept = action === 'encode' ? 'image/png,image/jpeg' : 'image/png';
        input.current.click();
    };
    async function process(file: File, action: 'encode' | 'decode') {
        if (busy.current) return;
        const gen = generation.current;
        const live = () => generation.current === gen && SelectedChannelStore.getChannelId() === channel.id;
        busy.current = true;
        try {
            if (action === 'encode') {
                const carrier = await encodeFile(file, settings.store.salt);
                if (live()) await UploadHandler.promptToUpload([carrier], channel, DraftType.ChannelMessage);
            } else {
                const plain = await decodeFile(file, settings.store.salt);
                if (!live()) return;
                const url = URL.createObjectURL(plain);
                try {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = file.name.replace(/\.png$/i, '') + '-decoded.png';
                    a.click();
                } finally { setTimeout(() => URL.revokeObjectURL(url), 10_000); }
            }
        } catch (error) {
            if (live()) showToast({ text: 'MoeGuard：' + (error instanceof Error ? error.message : String(error)), variant: 'failure' });
        } finally { if (generation.current === gen) busy.current = false; }
    }
    return <><ChatBarButton tooltip="MoeGuard：左键混淆到草稿，右键还原本地 PNG" onClick={() => pick('encode')} onContextMenu={e => { e.preventDefault(); pick('decode'); }}><Icon/></ChatBarButton>
        <input key={channel.id} ref={input} type="file" hidden onChange={e => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) void process(file, mode.current);
        }}/></>;
};

type AttachedMessage = { id: string; channel_id: string; attachments: readonly unknown[] };
function Received({ message }: { message: AttachedMessage }) {
    const marker = React.useRef<HTMLSpanElement>(null);
    const { salt } = settings.use(['salt']);
    React.useLayoutEffect(() => {
        if (marker.current) return bindMessage(marker.current, message, salt);
    }, [message.id, message.channel_id, message.attachments, salt]);
    return <span hidden aria-hidden="true" ref={marker}/>;
}

export default definePlugin({
    name: 'MoeGuard',
    description: '在本地混淆图片后放入 Discord 草稿，或还原已有的 MoeGuard PNG。',
    authors: [{ name: 'MoeGuard', id: 0n }],
    settings,
    renderMessageAccessory: props => !props.isMessageSnapshot && props.message?.attachments?.length ? <Received message={props.message}/> : null,
    chatBarButton: { render: Tools, icon: Icon }
});
