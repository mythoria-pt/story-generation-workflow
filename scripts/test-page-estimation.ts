/**
 * Test script to demonstrate page estimation functionality
 * Run this with: npm run ts-node scripts/test-page-estimation.ts
 */

import { estimateChapterPages, calculateChapterLayout, debugPageLayout } from '../src/utils/page-estimation.js';

// Sample chapter data for testing
const sampleChapters = [
  {
    title: "The Beginning",
    content: `<p>Once upon a time, in a magical kingdom far away, there lived a young princess who had extraordinary powers. She could talk to animals, make flowers bloom with just a touch, and her laughter could heal any sadness. However, she was unaware of these gifts, living a simple life in the castle.</p><p>One day, a terrible darkness began to spread across the land. The trees withered, the rivers dried up, and the people became sad and hopeless. The king called for help from all the wise wizards and brave knights, but none could find a solution to this mysterious curse.</p><p>It was then that an old sage appeared at the castle gates, speaking of an ancient prophecy about a pure-hearted royal who would save the kingdom from eternal darkness.</p>`,
    imageUri: "chapter1.jpg"
  },
  {
    title: "The Discovery",
    content: `<p>The princess overheard the conversation between her father and the sage. Curious and concerned about her people's suffering, she decided to learn more about this prophecy. She snuck into the castle's ancient library, where dusty books held secrets of centuries past.</p><p>There, among the old scrolls and magical texts, she found a book that seemed to glow when she touched it. As she opened it, golden letters appeared on the pages, telling the story of her ancestors and revealing the truth about her own magical heritage.</p><p>The book explained that every generation of her family had one member blessed with the power to restore balance to the world. The signs were clear: her ability to communicate with nature, her healing laughter, and most importantly, her pure and kind heart.</p><p>But with great power came great responsibility. The book warned that she would face many challenges and would need to find three sacred artifacts hidden throughout the kingdom to break the curse and restore peace.</p>`,
    imageUri: "chapter2.jpg"
  },
  {
    title: "The Journey Begins",
    content: `<p>Armed with newfound knowledge and determination, the princess decided to embark on the quest. She couldn't tell her parents, knowing they would never allow her to face such dangers. Instead, she left a note explaining her mission and promising to return victorious.</p><p>She packed only the essentials: some food, water, the magical book, and her grandmother's enchanted amulet that had been passed down through generations. As she stepped out of the castle in the early morning mist, she felt both excited and terrified about the adventure ahead.</p><p>The first artifact, according to the book, was hidden in the Whispering Woods, a mysterious forest where lost travelers often heard voices calling their names. Many who entered never returned, but the princess knew she had no choice but to venture into this dangerous place.</p><p>As she walked toward the forest, the animals began to gather around her – birds flew overhead, rabbits hopped alongside her path, and even the usually shy deer came out to see her off. They seemed to understand her mission and wanted to show their support.</p><p>At the edge of the Whispering Woods, she took a deep breath, said a prayer for courage, and stepped into the shadows between the ancient trees.</p>`,
    imageUri: "chapter3.jpg"
  }
];

console.log('\n=== Page Estimation Test ===\n');

// Test different target audiences
const audiences = ['children-3-6', 'children-7-10', 'young-adult-15-17', 'adult-18-plus'];

audiences.forEach(audience => {
  console.log(`\n--- Testing ${audience} ---`);
  
  sampleChapters.forEach((chapter, index) => {
    const pages = estimateChapterPages(chapter.content, audience);
    console.log(`Chapter ${index + 1} ("${chapter.title}"): ${pages} pages`);
  });
  
  // Test complete layout calculation
  console.log(`\nComplete layout for ${audience}:`);
  debugPageLayout(sampleChapters, audience);
});

// Test individual chapter estimation
console.log('\n=== Individual Chapter Tests ===\n');

const shortContent = '<p>This is a very short chapter.</p>';
const longContent = '<p>' + 'A'.repeat(3000) + '</p>';

console.log('Short content estimation:');
audiences.forEach(audience => {
  const pages = estimateChapterPages(shortContent, audience);
  console.log(`  ${audience}: ${pages} pages`);
});

console.log('\nLong content estimation (3000 chars):');
audiences.forEach(audience => {
  const pages = estimateChapterPages(longContent, audience);
  console.log(`  ${audience}: ${pages} pages`);
});

console.log('\n=== Test Complete ===\n');
