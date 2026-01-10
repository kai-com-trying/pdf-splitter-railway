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

// CONVERT TO IMAGES ENDPOINT (Using pdftoppm with smart DPI calculation)
app.post('/api/convert-to-images', async (req, res) => {
  const tempDir = path.join(__dirname, 'temp');
  let tempPdfPath = null;
  let outputPrefix = null;
  let timestamp = null;

  try {
    const { pdf, pages, maxSize = 5, maxDimension = 8000 } = req.body;
    if (!pdf) return res.status(400).json({ error: 'PDF data is required' });

    await fs.mkdir(tempDir, { recursive: true });

    const pdfBuffer = Buffer.from(pdf, 'base64');
    timestamp = Date.now();
    tempPdfPath = path.join(tempDir, `input_${timestamp}.pdf`);
    outputPrefix = path.join(tempDir, `output_${timestamp}`);
    
    await fs.writeFile(tempPdfPath, pdfBuffer);

    // Get PDF page dimensions using pdfinfo
    const { stdout: infoOutput } = await execAsync(`pdfinfo "${tempPdfPath}"`);
    const pageSizeMatch = infoOutput.match(/Page size:\s+([\d.]+)\s+x\s+([\d.]+)/);
    
    let dpi = 300; // Default DPI
    
    if (pageSizeMatch) {
      const pdfWidthPt = parseFloat(pageSizeMatch[1]);
      const pdfHeightPt = parseFloat(pageSizeMatch[2]);
      
      // Calculate what DPI would give us maxDimension on the longest side
      // PDF points to pixels: pixels = (points / 72) * DPI
      const maxPdfDimPt = Math.max(pdfWidthPt, pdfHeightPt);
      const targetDpi = (maxDimension * 72) / maxPdfDimPt;
      
      // Use the lower of target DPI or 300 DPI to avoid oversized images
      dpi = Math.min(Math.floor(targetDpi), 300);
      
      console.log(`PDF dimensions: ${pdfWidthPt}x${pdfHeightPt} pt`);
      console.log(`Calculated DPI: ${dpi} (to fit in ${maxDimension}px)`);
    }

    // Convert using pdftoppm with calculated DPI
    let command = `pdftoppm -png -r ${dpi} "${tempPdfPath}" "${outputPrefix}"`;
    
    if (pages && Array.isArray(pages) && pages.length > 0) {
      const pageCommands = pages.map(pageNum => 
        `pdftoppm -png -r ${dpi} -f ${pageNum} -l ${pageNum} "${tempPdfPath}" "${outputPrefix}_page${pageNum}"`
      );
      command = pageCommands.join(' && ');
    }

    console.log('Converting PDF to images with DPI:', dpi);
    await execAsync(command);

    // Read and process images
    const files = await fs.readdir(tempDir);
    const imageFiles = files
      .filter(f => f.startsWith(`output_${timestamp}`) && f.endsWith('.png'))
      .sort();

    const responseImages = [];
    const maxSizeBytes = maxSize * 1024 * 1024;
    
    for (const file of imageFiles) {
      const filePath = path.join(tempDir, file);
      let imageBuffer = await fs.readFile(filePath);
      
      // Check actual dimensions
      const { stdout: dimensionOutput } = await execAsync(`identify -format "%w %h" "${filePath}"`);
      const [width, height] = dimensionOutput.trim().split(' ').map(Number);
      
      console.log(`Image ${file}: ${width}x${height} pixels, ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      
      let needsResize = false;
      
      // Double-check dimensions (shouldn't happen with smart DPI, but just in case)
      if (width > maxDimension || height > maxDimension) {
        console.log(`WARNING: Image still exceeds ${maxDimension}px, force resizing...`);
        needsResize = true;
      }
      
      // Check file size
      if (imageBuffer.length > maxSizeBytes) {
        console.log(`Image exceeds ${maxSize}MB, compressing...`);
        needsResize = true;
      }
      
      if (needsResize) {
        // Calculate new dimensions
        let newWidth = width;
        let newHeight = height;
        
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            newWidth = maxDimension;
            newHeight = Math.floor(height * (maxDimension / width));
          } else {
            newHeight = maxDimension;
            newWidth = Math.floor(width * (maxDimension / height));
          }
        }
        
        // Convert to JPEG for better compression and less memory usage
        const jpegPath = filePath.replace('.png', '.jpg');
        
        // Use progressive resizing for memory efficiency
        await execAsync(`convert "${filePath}" -limit memory 256MB -limit map 512MB -resize ${newWidth}x${newHeight} -quality 85 -strip "${jpegPath}"`);
        
        imageBuffer = await fs.readFile(jpegPath);
        await fs.unlink(jpegPath);
        
        console.log(`  → Resized to ${newWidth}x${newHeight}, ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB`);
      }
      
      const base64Image = imageBuffer.toString('base64');
      const match = file.match(/-(\d+)\.png$/);
      const pageNum = match ? parseInt(match[1]) : responseImages.length + 1;
      
      responseImages.push({ 
        page: pageNum, 
        base64: base64Image,
        size_mb: (imageBuffer.length / 1024 / 1024).toFixed(2),
        dimensions: `${width}x${height}`,
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
      dpi: dpi,
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