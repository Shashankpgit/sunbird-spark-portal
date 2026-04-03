import { v4 as uuidv4 } from 'uuid';
import packageJson from '../../package.json' with { type: 'json' };
import { envConfig } from '../config/env.js';

const { version, buildHash } = packageJson as { version: string; buildHash?: string };

export const buildInfo = {
    buildHash: buildHash || uuidv4(),
    appId: envConfig.APPID,
    version,
};
