/**
 * Test script for the new PDF generation endpoint
 * 
 * This script demonstrates how to use the new /pdf/create endpoint
 * to generate PDFs separately from the story assembly process.
 */

// Example usage of the new PDF endpoint:

const testPDFGeneration = async () => {
  const storyId = 'your-story-id-here'; // Replace with actual story ID
  
  try {
    const response = await fetch('http://localhost:3000/pdf/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        storyId: storyId
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('PDF generation failed:', errorData);
      return;
    }

    const result = await response.json();
    console.log('PDF generated successfully!');
    console.log('PDF URI:', result.pdfUri);
    console.log('Version:', result.version);
    console.log('Metadata:', result.metadata);
    
  } catch (error) {
    console.error('Error calling PDF endpoint:', error);
  }
};

// Example of what the response looks like:
/*
{
  "message": "PDF created successfully",
  "storyId": "12345-67890-abcdef",
  "pdfUri": "https://storage.googleapis.com/your-bucket/12345-67890-abcdef/story_v001.pdf",
  "version": "1",
  "metadata": {
    "title": "My Amazing Story",
    "wordCount": 2500,
    "pageCount": 15,
    "generatedAt": "2025-06-22T14:30:00.000Z"
  }
}
*/

// For testing, you can also use curl:
/*
curl -X POST http://localhost:3000/pdf/create \
  -H "Content-Type: application/json" \
  -d '{"storyId": "your-story-id-here"}'
*/

export { testPDFGeneration };
