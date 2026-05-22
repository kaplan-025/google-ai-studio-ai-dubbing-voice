
import { extractSibnet } from './sibnetExtractor';

async function runTest() {
  const url = "";
  console.log(`Extracting: ${url}`);
  try {
    const result = await extractSibnet(url);
    console.log("Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Extraction error:", error);
  }
}

runTest();
