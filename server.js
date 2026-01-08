import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPLIT PDF ENDPOINT (Using Poppler)
app.post('/api/split-pdf', async (req, res) => {
  const tempDir = path.join(__dirname, 'temp');
  let tempPdfPath = null;

  try {
    const { pdf, page } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    await fs.mkdir(tempDir, { recursive: true });

    const pdfBuffer = Buffer.from(pdf, 'base64');
    const timestamp = Date.now();
    tempPdfPath = path.join(tempDir, `input_${timestamp}.pdf`);
    
    await fs.writeFile(tempPdfPath, pdfBuffer);

    // Get page count using pdfinfo (poppler)
    const { stdout: infoOutput } = await execAsync(`pdfinfo "${tempPdfPath}"`);
    const pageCountMatch = infoOutput.match(/Pages:\s+(\d+)/);
    const pageCount = pageCountMatch ? parseInt(pageCountMatch[1]) : 0;

    if (page) {
      const pageNumber = parseInt(page);
      if (pageNumber < 1 || pageNumber > pageCount) {
        await fs.unlink(tempPdfPath);
        return res.status(400).json({ error: 'Invalid page number', totalPages: pageCount });
      }

      // Extract single page using pdfseparate
      const outputPath = path.join(tempDir, `output_${timestamp}_page${pageNumber}.pdf`);
      await execAsync(`pdfseparate -f ${pageNumber} -l ${pageNumber} "${tempPdfPath}" "${outputPath}"`);
      
      const pageBuffer = await fs.readFile(outputPath);
      await fs.unlink(tempPdfPath);
      await fs.unlink(outputPath);

      return res.status(200).json({
        page: pageNumber,
        totalPages: pageCount,
        base64: pageBuffer.toString('base64')
      });
    }

    // Split all pages
    const outputPattern = path.join(tempDir, `output_${timestamp}_%d.pdf`);
    await execAsync(`pdfseparate "${tempPdfPath}" "${outputPattern}"`);

    const files = await fs.readdir(tempDir);
    const pdfFiles = files
      .filter(f => f.startsWith(`output_${timestamp}_`) && f.endsWith('.pdf'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/_(\d+)\.pdf$/)[1]);
        const numB = parseInt(b.match(/_(\d+)\.pdf$/)[1]);
        return numA - numB;
      });

    const pages = [];
    for (const file of pdfFiles) {
      const filePath = path.join(tempDir, file);
      const pageBuffer = await fs.readFile(filePath);
      const pageNum = parseInt(file.match(/_(\d+)\.pdf$/)[1]);
      pages.push({ page: pageNum, base64: pageBuffer.toString('base64') });
      await fs.unlink(filePath);
    }

    await fs.unlink(tempPdfPath);

    return res.status(200).json({ count: pageCount, pages: pages });

  } catch (error) {
    console.error('Error in split-pdf:', error);
    if (tempPdfPath) {
      try { await fs.unlink(tempPdfPath); } catch {}
    }
    return res.status(500).json({ error: error.message });
  }
});

// CONVERT TO IMAGES ENDPOINT (Using pdftoppm with dimension and size checking)
app.post('/api/convert-to-images', async (req, res) => {
  const tempDir = path.join(__dirname, 'temp');
  let tempPdfPath = null;
  let outputPrefix = null;
  let timestamp = null;

  try {
    const { pdf, pages, maxSize = 5, maxDimension = 8000 } = req.body; // maxSize in MB, maxDimension in pixels
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    await fs.mkdir(tempDir, { recursive: true });

    const pdfBuffer = Buffer.from(pdf, 'base64');

    timestamp = Date.now();
    tempPdfPath = path.join(tempDir, `input_${timestamp}.pdf`);
    outputPrefix = path.join(tempDir, `output_${timestamp}`);
    
    await fs.writeFile(tempPdfPath, pdfBuffer);

    // Convert using pdftoppm with high quality
    let command = `pdftoppm -png -r 300 "${tempPdfPath}" "${outputPrefix}"`;
    
    if (pages && Array.isArray(pages) && pages.length > 0) {
      const pageCommands = pages.map(pageNum => 
        `pdftoppm -png -r 300 -f ${pageNum} -l ${pageNum} "${tempPdfPath}" "${outputPrefix}_page${pageNum}"`
      );
      command = pageCommands.join(' && ');
    }

    console.log('Converting PDF to images using pdftoppm...');
    await execAsync(command);

    // Read and process images
    const files = await fs.readdir(tempDir);
    const imageFiles = files
      .filter(f => f.startsWith(`output_${timestamp}`) && f.endsWith('.png'))
      .sort();

    const responseImages = [];
    const maxSizeBytes = maxSize * 1024 * 1024; // Convert MB to bytes
    
    for (const file of imageFiles) {
      const filePath = path.join(tempDir, file);
      let imageBuffer = await fs.readFile(filePath);
      let needsResize = false;
      let resizeReason = '';
      
      // Check pixel dimensions first (CRITICAL for Anthropic API)
      const { stdout: dimensionOutput } = await execAsync(`identify -format "%w %h" "${filePath}"`);
      const [width, height] = dimensionOutput.trim().split(' ').map(Number);
      
      console.log(`Image ${file}: ${width}x${height} pixels, ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      
      // Check if dimensions exceed maxDimension (Anthropic API limit)
      if (width > maxDimension || height > maxDimension) {
        needsResize = true;
        resizeReason = `dimensions (${width}x${height}) exceed ${maxDimension}px`;
      }
      
      // Check if file size exceeds maxSize
      if (imageBuffer.length > maxSizeBytes) {
        needsResize = true;
        resizeReason = resizeReason 
          ? `${resizeReason} AND file size (${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB) exceeds ${maxSize}MB`
          : `file size (${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB) exceeds ${maxSize}MB`;
      }
      
      if (needsResize) {
        console.log(`Resizing ${file}: ${resizeReason}`);
        
        const resizedPath = filePath.replace('.png', '_resized.png');
        
        // Calculate new dimensions maintaining aspect ratio
        let newWidth = width;
        let newHeight = height;
        
        // First, ensure dimensions are under maxDimension
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            newWidth = maxDimension;
            newHeight = Math.floor(height * (maxDimension / width));
          } else {
            newHeight = maxDimension;
            newWidth = Math.floor(width * (maxDimension / height));
          }
          
          console.log(`  → Dimension resize: ${width}x${height} → ${newWidth}x${newHeight}`);
        }
        
        // Resize using ImageMagick with dimension constraints
        await execAsync(`convert "${filePath}" -resize ${newWidth}x${newHeight} "${resizedPath}"`);
        
        imageBuffer = await fs.readFile(resizedPath);
        
        // If still too large by file size, reduce quality
        if (imageBuffer.length > maxSizeBytes) {
          console.log(`  → Still ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB, reducing quality...`);
          
          // Calculate quality reduction needed
          const qualityFactor = Math.sqrt(maxSizeBytes / imageBuffer.length) * 0.9; // 0.9 for safety
          const quality = Math.max(60, Math.floor(qualityFactor * 100)); // Min 60% quality
          
          const qualityPath = filePath.replace('.png', '_quality.png');
          await execAsync(`convert "${resizedPath}" -quality ${quality} "${qualityPath}"`);
          
          await fs.unlink(resizedPath);
          imageBuffer = await fs.readFile(qualityPath);
          await fs.unlink(qualityPath);
        } else {
          await fs.unlink(resizedPath);
        }
        
        console.log(`  ✓ Final: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      }
      
      const base64Image = imageBuffer.toString('base64');
      const match = file.match(/-(\d+)\.png$/);
      const pageNum = match ? parseInt(match[1]) : responseImages.length + 1;
      
      // Get final dimensions
      const finalDimensions = needsResize ? 
        await execAsync(`identify -format "%w %h" "${filePath}"`).then(r => r.stdout.trim()) :
        `${width} ${height}`;
      const [finalWidth, finalHeight] = finalDimensions.split(' ').map(Number);
      
      responseImages.push({ 
        page: pageNum, 
        base64: base64Image,
        size_mb: (imageBuffer.length / 1024 / 1024).toFixed(2),
        dimensions: `${finalWidth}x${finalHeight}`,
        resized: needsResize
      });
      
      await fs.unlink(filePath);
    }

    if (tempPdfPath) {
      await fs.unlink(tempPdfPath);
    }

    return res.status(200).json({ 
      count: responseImages.length, 
      images: responseImages,
      maxDimension: maxDimension,
      maxSize: maxSize
    });

  } catch (error) {
    console.error('Error in convert-to-images:', error);
    
    try {
      if (tempPdfPath) await fs.unlink(tempPdfPath);
      if (timestamp) {
        const files = await fs.readdir(tempDir);
        const cleanupFiles = files.filter(f => f.startsWith(`output_${timestamp}`));
        await Promise.all(cleanupFiles.map(f => fs.unlink(path.join(tempDir, f)).catch(() => {})));
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    return res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'PDF Splitter API', 
    endpoints: { 
      health: 'GET /health', 
      splitPdf: 'POST /api/split-pdf',
      convertToImages: 'POST /api/convert-to-images'
    } 
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});