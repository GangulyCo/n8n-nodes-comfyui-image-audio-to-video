import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import FormData from 'form-data';

interface ComfyUINode {
	inputs: Record<string, any>;
	class_type: string;
	_meta?: {
		title: string;
	};
}

interface ComfyUIWorkflow {
	[key: string]: ComfyUINode;
}

interface ImageInfo {
	name: string;
	subfolder: string;
	type: string;
}

export class ComfyuiImageAudioToVideo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ComfyUI Image Audio to Video',
		name: 'comfyuiImageAudioToVideo',
		icon: 'file:comfyui.svg',
		group: ['transform'],
		version: 1,
		description: 'Convert images and audio to videos using ComfyUI workflow',
		defaults: {
			name: 'ComfyUI Image Audio to Video',
		},
		credentials: [
			{
				name: 'comfyUIApi',
				required: true,
			},
		],
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Workflow JSON',
				name: 'workflow',
				type: 'string',
				typeOptions: {
					rows: 10,
				},
				default: '',
				required: true,
				description: 'The ComfyUI workflow in JSON format',
			},
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				options: [
					{ name: 'URL', value: 'url' },
					{ name: 'Base64', value: 'base64' },
					{ name: 'Binary', value: 'binary' }
				],
				default: 'url',
				required: true,
			},
			{
				displayName: 'Input Image',
				name: 'inputImage',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						inputType: ['url', 'base64'],
					},
				},
				description: 'URL or base64 data of the input image',
			},
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						inputType: ['binary'],
					},
				},
				description: 'Name of the binary property containing the image',
			},
			{
				displayName: 'Audio Binary Property',
				name: 'audioBinaryPropertyName',
				type: 'string',
				default: '',
				description: 'Optional: Name of the binary property containing the audio MP3 file to attach (will look for LoadAudio node)',
			},
			{
				displayName: 'Timeout',
				name: 'timeout',
				type: 'number',
				default: 30,
				description: 'Maximum time in minutes to wait for video generation',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials = await this.getCredentials('comfyUIApi');
		const workflow = this.getNodeParameter('workflow', 0) as string;
		const inputType = this.getNodeParameter('inputType', 0) as string;
		const timeout = this.getNodeParameter('timeout', 0) as number;

		const apiUrl = credentials.apiUrl as string;
		const apiKey = credentials.apiKey as string;

		console.log('[ComfyUI] Executing image to video conversion with API URL:', apiUrl);

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (apiKey) {
			console.log('[ComfyUI] Using API key authentication');
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		try {
			// Check API connection
			console.log('[ComfyUI] Checking API connection...');
			await this.helpers.request({
				method: 'GET',
				url: `${apiUrl}/system_stats`,
				headers,
				json: true,
			});

			// Prepare input image
			let imageBuffer: Buffer;
			
			if (inputType === 'url') {
				// Download image from URL
				const inputImage = this.getNodeParameter('inputImage', 0) as string;
				console.log('[ComfyUI] Downloading image from URL:', inputImage);
				const response = await this.helpers.request({
					method: 'GET',
					url: inputImage,
					encoding: null,
				});
				imageBuffer = Buffer.from(response);
			} else if (inputType === 'binary') {
				// Get binary data using helpers
				console.log('[ComfyUI] Getting binary data from input');
				
				// Get the binary property name
				const binaryPropertyName = this.getNodeParameter('binaryPropertyName', 0) as string;
				console.log('[ComfyUI] Looking for binary property:', binaryPropertyName);
				
				// Log available binary properties for debugging
				const items = this.getInputData();
				const binaryProperties = Object.keys(items[0].binary || {});
				console.log('[ComfyUI] Available binary properties:', binaryProperties);
				
				// Try to find the specified binary property
				let actualPropertyName = binaryPropertyName;
				
				if (!items[0].binary?.[binaryPropertyName]) {
					console.log(`[ComfyUI] Binary property "${binaryPropertyName}" not found, searching for alternatives...`);
					
					// Try to find any image property as fallback
					const imageProperty = binaryProperties.find(key => 
						items[0].binary![key].mimeType?.startsWith('image/')
					);
					
					if (imageProperty) {
						console.log(`[ComfyUI] Found alternative image property: "${imageProperty}"`);
						actualPropertyName = imageProperty;
					} else {
						throw new NodeApiError(this.getNode(), { 
							message: `No binary data found in property "${binaryPropertyName}" and no image alternatives found`
						});
					}
				}
				
				// Get binary data
				imageBuffer = await this.helpers.getBinaryDataBuffer(0, actualPropertyName);
				console.log('[ComfyUI] Got binary data, size:', imageBuffer.length, 'bytes');
				
				// Get mime type for validation
				const mimeType = items[0].binary![actualPropertyName].mimeType;
				console.log('[ComfyUI] Binary data mime type:', mimeType);
				
				// Validate it's an image
				if (!mimeType || !mimeType.startsWith('image/')) {
					throw new NodeApiError(this.getNode(), {
						message: `Invalid media type: ${mimeType}. Only images are supported.`
					});
				}
			} else {
				// Base64 input
				const inputImage = this.getNodeParameter('inputImage', 0) as string;
				imageBuffer = Buffer.from(inputImage, 'base64');
			}

			// Helper to upload buffer (image/audio) using the /upload/image endpoint per requirements
			const uploadBuffer = async (buffer: Buffer, filename: string): Promise<ImageInfo> => {
				console.log(`[ComfyUI] Uploading file ${filename}...`);
				const fd = new FormData();
				fd.append('image', buffer, filename); // Using field name 'image' as requested
				fd.append('subfolder', '');
				fd.append('overwrite', 'true');
				const resp = await this.helpers.request({
					method: 'POST',
					url: `${apiUrl}/upload/image`,
					headers: {
						...headers,
						...fd.getHeaders(),
					},
					body: fd,
				});
				const info = JSON.parse(resp) as ImageInfo;
				console.log('[ComfyUI] Upload response for', filename, info);
				return info;
			};

			// Always upload image first
			const imageInfo = await uploadBuffer(imageBuffer, 'input.png');

			// Optional audio upload
			const audioBinaryPropertyName = this.getNodeParameter('audioBinaryPropertyName', 0, '') as string;
			let audioInfo: ImageInfo | null = null;
			if (audioBinaryPropertyName) {
				const items = this.getInputData();
				if (!items[0].binary?.[audioBinaryPropertyName]) {
					console.log(`[ComfyUI] Audio binary property "${audioBinaryPropertyName}" not found, skipping audio upload.`);
				} else {
					console.log('[ComfyUI] Preparing audio upload from property:', audioBinaryPropertyName);
					const audioBinary = items[0].binary[audioBinaryPropertyName];
					const mimeType = audioBinary.mimeType || '';
					if (!mimeType.startsWith('audio/')) {
						throw new NodeApiError(this.getNode(), { message: `Provided audio binary property is not audio (mime: ${mimeType})` });
					}
					const audioBuffer = await this.helpers.getBinaryDataBuffer(0, audioBinaryPropertyName);
					// Use .mp3 filename even if other audio provided (per requirement mp3)
					audioInfo = await uploadBuffer(audioBuffer, 'input.mp3');
				}
			}

			// Parse and modify workflow JSON
			let workflowData;
			try {
				workflowData = JSON.parse(workflow);
			} catch (error) {
				throw new NodeApiError(this.getNode(), { 
					message: 'Invalid workflow JSON. Please check the JSON syntax and try again.',
					description: error.message
				});
			}

			// Validate workflow structure
			if (typeof workflowData !== 'object' || workflowData === null) {
				throw new NodeApiError(this.getNode(), { 
					message: 'Invalid workflow structure. The workflow must be a valid JSON object.'
				});
			}

			// Find and update LoadImage node
			const loadImageNode = Object.values(workflowData as ComfyUIWorkflow).find((node: ComfyUINode) =>
				node.class_type === 'LoadImage' && node.inputs && node.inputs.image !== undefined
			);
			if (!loadImageNode) {
				throw new NodeApiError(this.getNode(), { message: 'No LoadImage node found in the workflow. The workflow must contain a LoadImage node with an image input.' });
			}
			loadImageNode.inputs.image = imageInfo.name;
			console.log('[ComfyUI] LoadImage node updated with image name:', imageInfo.name);

			// Find and update LoadAudio node if audio uploaded
			if (audioInfo) {
				const loadAudioNode = Object.values(workflowData as ComfyUIWorkflow).find((node: ComfyUINode) =>
					node.class_type === 'LoadAudio' && node.inputs && (node.inputs.audio !== undefined || node.inputs.filename !== undefined)
				);
				if (!loadAudioNode) {
					throw new NodeApiError(this.getNode(), { message: 'Audio binary provided but no LoadAudio node found in the workflow.' });
				}
				// Different workflows may use "audio" or "filename" for LoadAudio
				if (loadAudioNode.inputs.audio !== undefined) {
					loadAudioNode.inputs.audio = audioInfo.name;
				} else if (loadAudioNode.inputs.filename !== undefined) {
					loadAudioNode.inputs.filename = audioInfo.name;
				} else {
					// Fallback - set a common property
					loadAudioNode.inputs.audio = audioInfo.name;
				}
				console.log('[ComfyUI] LoadAudio node updated with audio name:', audioInfo.name);
			}

			// Queue video generation
			console.log('[ComfyUI] Queueing video generation...');
			const response = await this.helpers.request({
				method: 'POST',
				url: `${apiUrl}/prompt`,
				headers,
				body: {
					prompt: workflowData,
				},
				json: true,
			});

			if (!response.prompt_id) {
				throw new NodeApiError(this.getNode(), { message: 'Failed to get prompt ID from ComfyUI' });
			}

			const promptId = response.prompt_id;
			console.log('[ComfyUI] Video generation queued with ID:', promptId);

			// Poll for completion
			let attempts = 0;
			const maxAttempts = 60 * timeout; // Convert minutes to seconds
			await new Promise(resolve => setTimeout(resolve, 5000));
			while (attempts < maxAttempts) {
				console.log(`[ComfyUI] Checking video generation status (attempt ${attempts + 1}/${maxAttempts})...`);
				await new Promise(resolve => setTimeout(resolve, 1000));
				attempts++;

				const history = await this.helpers.request({
					method: 'GET',
					url: `${apiUrl}/history/${promptId}`,
					headers,
					json: true,
				});

				const promptResult = history[promptId];
				if (!promptResult) {
					console.log('[ComfyUI] Prompt not found in history');
					continue;
				}

				if (promptResult.status === undefined) {
					console.log('[ComfyUI] Execution status not found');
					continue;
				}

				if (promptResult.status?.completed) {
					console.log('[ComfyUI] Video generation completed');

					if (promptResult.status?.status_str === 'error') {
						throw new NodeApiError(this.getNode(), { message: '[ComfyUI] Video generation failed' });
					}

					// Check outputs structure
					console.log('[ComfyUI] Raw outputs structure:', JSON.stringify(promptResult.outputs, null, 2));
					
					// Get all images outputs with simpler approach
					const mediaOutputs = Object.values(promptResult.outputs)
						.flatMap((nodeOutput: any) => nodeOutput.images || nodeOutput.gifs || [])
						.filter((image: any) => image.type === 'output' || image.type === 'temp')
						.map((img: any) => ({
							...img,
							url: `${apiUrl}/view?filename=${img.filename}&subfolder=${img.subfolder || ''}&type=${img.type}`
						}));

					console.log('[ComfyUI] Found media outputs:', mediaOutputs);

					if (mediaOutputs.length === 0) {
						throw new NodeApiError(this.getNode(), { message: '[ComfyUI] No media outputs found in results' });
					}

					// Prioritize video outputs (WEBP, MP4, etc.)
					const videoOutputs = mediaOutputs.filter(output => 
						output.filename.endsWith('.webp') || 
						output.filename.endsWith('.mp4') ||
						output.filename.endsWith('.gif')
					);

					if (videoOutputs.length === 0) {
						throw new NodeApiError(this.getNode(), { message: '[ComfyUI] No video outputs found in results' });
					}

					console.log('[ComfyUI] Found video outputs:', videoOutputs);

					// Return the first video output
					const videoOutput = videoOutputs[0];
                    
                    const videoResponse = await this.helpers.request({
                        method: 'GET',
                        url: videoOutput.url,
                        encoding: null,
                        resolveWithFullResponse: true
                    });

                    if (videoResponse.statusCode === 404) {
                        throw new NodeApiError(this.getNode(), { message: `Video file not found at ${videoOutput.url}` });
                    }

                    console.log('[ComfyUI] Using media directly from ComfyUI');
                    const buffer = Buffer.from(videoResponse.body);
                    const base64Data = buffer.toString('base64');
                    const fileSize = Math.round(buffer.length / 1024 * 10) / 10 + " kB";

                    // Determine MIME type based on file extension
                    let mimeType = 'image/webp';
                    let fileExtension = 'webp';
                    
                    if (videoOutput.filename.endsWith('.mp4')) {
                        mimeType = 'video/mp4';
                        fileExtension = 'mp4';
                    } else if (videoOutput.filename.endsWith('.gif')) {
                        mimeType = 'image/gif';
                        fileExtension = 'gif';
                    }

                    return [[{
                        json: {
                            mimeType,
                            fileName: videoOutput.filename,
                            data: base64Data,
                            status: promptResult.status,
                        },
                        binary: {
                            data: {
                                fileName: videoOutput.filename,
                                data: base64Data,
                                fileType: 'video',
                                fileSize,
                                fileExtension,
                                mimeType
                            }
                        }
                    }]];
				}
			}
			throw new NodeApiError(this.getNode(), { message: `Video generation timeout after ${timeout} minutes` });
		} catch (error) {
			console.error('[ComfyUI] Video generation error:', error);
			throw new NodeApiError(this.getNode(), { 
				message: `ComfyUI API Error: ${error.message}`,
				description: error.description || ''
			});
		}
	}
} 