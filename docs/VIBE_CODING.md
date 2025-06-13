# Vibe Coding plan

## ~START~
On the root of my repository, I want to create a new NodeJs application, named "story-generation-workflow".
We will use Google Cloud Workflows to orchestrate all this process.

The process consists of the following steps:
1. **storyOutline** - This step will get the story structure and generate a full synopses and chapters
2. "chapterWriting** - This step will loop, for each chapter, and write the chapter contents and image prompts.
3. "imageGeneration** - Using the image prompts previously generate, this step will generate the images and store them on Google Storage
4. **finalProduction** - This step combines everything and generates an HTML output and a PDF file
5. **audioRecording** - This step is optional, and it narrates the story to audio.

Like the Mythoria-webapp the service will be hosted on Google Cloud Run.
Create a recomendeded blueprint to host and start developping this service.

We need to share the same drizzle database schema and migrations set on the mythoria-webapp.

Tips
- Single Dockerfile per micro-service; use distroless + npm ci for reproducible builds.
- Place environment-agnostic logic in shared/ so you can unit-test without a Google stub.
- Keep Firestore/SQL adapters behind an interface so you can swap to mocks in tests.

Use a .env.schema.json to validate required vars (MODEL_ID, BUCKET_NAME, etc.).

IMPORTANT: ONLYE GENERATE THE BASE FOLDER, IMPORTS AND CONFIG FILES. DO NOT GENERATE ANY BUSINESS LOGIC OR CODE FOR NOW.

