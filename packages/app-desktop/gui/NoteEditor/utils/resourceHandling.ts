import shim from '@joplin/lib/shim';
import Setting from '@joplin/lib/models/Setting';
import Note from '@joplin/lib/models/Note';
import BaseModel from '@joplin/lib/BaseModel';
import Resource from '@joplin/lib/models/Resource';
const bridge = require('@electron/remote').require('./bridge').default;
import ResourceFetcher from '@joplin/lib/services/ResourceFetcher';
import htmlUtils from '@joplin/lib/htmlUtils';
import rendererHtmlUtils, { extractHtmlBody } from '@joplin/renderer/htmlUtils';
import Logger from '@joplin/utils/Logger';
import { fileUriToPath } from '@joplin/utils/url';
import { MarkupLanguage } from '@joplin/renderer';
import { HtmlToMarkdownHandler, MarkupToHtmlHandler } from './types';
import markupRenderOptions from './markupRenderOptions';
const joplinRendererUtils = require('@joplin/renderer').utils;
const { clipboard } = require('electron');
const mimeUtils = require('@joplin/lib/mime-utils.js').mime;
const md5 = require('md5');
const path = require('path');

const logger = Logger.create('resourceHandling');

export async function handleResourceDownloadMode(noteBody: string) {
	if (noteBody && Setting.value('sync.resourceDownloadMode') === 'auto') {
		const resourceIds = await Note.linkedResourceIds(noteBody);
		await ResourceFetcher.instance().markForDownload(resourceIds);
	}
}

let resourceCache_: any = {};

export function clearResourceCache() {
	resourceCache_ = {};
}

export async function attachedResources(noteBody: string): Promise<any> {
	if (!noteBody) return {};
	const resourceIds = await Note.linkedItemIdsByType(BaseModel.TYPE_RESOURCE, noteBody);

	const output: any = {};
	for (let i = 0; i < resourceIds.length; i++) {
		const id = resourceIds[i];

		if (resourceCache_[id]) {
			output[id] = resourceCache_[id];
		} else {
			const resource = await Resource.load(id);
			const localState = await Resource.localState(resource);

			const o = {
				item: resource,
				localState: localState,
			};

			// eslint-disable-next-line require-atomic-updates
			resourceCache_[id] = o;
			output[id] = o;
		}
	}

	return output;
}

export async function commandAttachFileToBody(body: string, filePaths: string[] = null, options: any = null) {
	options = {
		createFileURL: false,
		position: 0,
		markupLanguage: MarkupLanguage.Markdown,
		...options,
	};

	if (!filePaths) {
		filePaths = await bridge().showOpenDialog({
			properties: ['openFile', 'createDirectory', 'multiSelections'],
		});
		if (!filePaths || !filePaths.length) return null;
	}

	for (let i = 0; i < filePaths.length; i++) {
		const filePath = filePaths[i];
		try {
			logger.info(`Attaching ${filePath}`);
			const newBody = await shim.attachFileToNoteBody(body, filePath, options.position, {
				createFileURL: options.createFileURL,
				resizeLargeImages: Setting.value('imageResizing'),
				markupLanguage: options.markupLanguage,
			});

			if (!newBody) {
				logger.info('File attachment was cancelled');
				return null;
			}

			body = newBody;
			logger.info('File was attached.');
		} catch (error) {
			logger.error(error);
			bridge().showErrorMessageBox(error.message);
		}
	}

	return body;
}

export function resourcesStatus(resourceInfos: any) {
	let lowestIndex = joplinRendererUtils.resourceStatusIndex('ready');
	for (const id in resourceInfos) {
		const s = joplinRendererUtils.resourceStatus(Resource, resourceInfos[id]);
		const idx = joplinRendererUtils.resourceStatusIndex(s);
		if (idx < lowestIndex) lowestIndex = idx;
	}
	return joplinRendererUtils.resourceStatusName(lowestIndex);
}

export async function getResourcesFromPasteEvent(event: any) {
	const output = [];
	const formats = clipboard.availableFormats();
	for (let i = 0; i < formats.length; i++) {
		const format = formats[i].toLowerCase();
		const formatType = format.split('/')[0];

		if (formatType === 'image') {
			if (event) event.preventDefault();

			const image = clipboard.readImage();

			const fileExt = mimeUtils.toFileExtension(format);
			const filePath = `${Setting.value('tempDir')}/${md5(Date.now())}.${fileExt}`;

			await shim.writeImageToFile(image, format, filePath);
			const md = await commandAttachFileToBody('', [filePath]);
			await shim.fsDriver().remove(filePath);

			if (md) output.push(md);
		}
	}
	return output;
}

export async function processPastedHtml(html: string, htmlToMd: HtmlToMarkdownHandler | null, mdToHtml: MarkupToHtmlHandler | null) {
	const allImageUrls: string[] = [];
	const mappedResources: Record<string, string> = {};

	// When copying text from eg. GitHub, the HTML might contain non-breaking
	// spaces instead of regular spaces. If these non-breaking spaces are
	// inserted into the TinyMCE editor (using insertContent), they will be
	// dropped. So here we convert them to regular spaces.
	// https://stackoverflow.com/a/31790544/561309
	html = html.replace(/[\u202F\u00A0]/g, ' ');

	htmlUtils.replaceImageUrls(html, (src: string) => {
		allImageUrls.push(src);
	});

	for (const imageSrc of allImageUrls) {
		if (!mappedResources[imageSrc]) {
			try {
				if (imageSrc.startsWith('file')) {
					const imageFilePath = path.normalize(fileUriToPath(imageSrc));
					const resourceDirPath = path.normalize(Setting.value('resourceDir'));

					if (imageFilePath.startsWith(resourceDirPath)) {
						mappedResources[imageSrc] = imageSrc;
					} else {
						const createdResource = await shim.createResourceFromPath(imageFilePath);
						mappedResources[imageSrc] = `file://${encodeURI(Resource.fullPath(createdResource))}`;
					}
				} else if (imageSrc.startsWith('data:')) { // Data URIs
					mappedResources[imageSrc] = imageSrc;
				} else {
					const filePath = `${Setting.value('tempDir')}/${md5(Date.now() + Math.random())}`;
					await shim.fetchBlob(imageSrc, { path: filePath });
					const createdResource = await shim.createResourceFromPath(filePath);
					await shim.fsDriver().remove(filePath);
					mappedResources[imageSrc] = `file://${encodeURI(Resource.fullPath(createdResource))}`;
				}
			} catch (error) {
				logger.warn(`Error creating a resource for ${imageSrc}.`, error);
				mappedResources[imageSrc] = imageSrc;
			}
		}
	}

	// TinyMCE can accept any type of HTML, including HTML that may not be preserved once saved as
	// Markdown. For example the content may have a dark background which would be supported by
	// TinyMCE, but lost once the note is saved. So here we convert the HTML to Markdown then back
	// to HTML to ensure that the content we paste will be handled correctly by the app.
	if (htmlToMd && mdToHtml) {
		const md = await htmlToMd(MarkupLanguage.Markdown, html, '');
		html = (await mdToHtml(MarkupLanguage.Markdown, md, markupRenderOptions({ bodyOnly: true }))).html;
	}

	return extractHtmlBody(rendererHtmlUtils.sanitizeHtml(
		htmlUtils.replaceImageUrls(html, (src: string) => {
			return mappedResources[src];
		}), {
			allowedFilePrefixes: [Setting.value('resourceDir')],
		},
	));
}
