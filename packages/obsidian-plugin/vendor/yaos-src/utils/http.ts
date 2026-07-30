import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

export async function obsidianRequest(
	request: RequestUrlParam,
): Promise<RequestUrlResponse> {
	return await requestUrl({
		...request,
		throw: false,
	});
}
