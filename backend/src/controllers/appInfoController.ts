import { Request, Response } from 'express';
import { Response as ApiResponse } from '../models/Response.js';
import { buildInfo } from '../services/buildInfo.js';

export const getAppInfo = (_req: Request, res: Response) => {
    const apiId = 'api.app.info';
    const response = new ApiResponse(apiId);

    response.setResult({
        data: {
            version: buildInfo.version,
            buildHash: buildInfo.buildHash,
            appId: buildInfo.appId,
        },
    });
    res.status(200).send(response);
};
