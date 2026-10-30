// Draws Margin's app icon into an .iconset folder (for iconutil), with CoreGraphics only, so the
// icon is rebuilt identically on any Mac: the favicon of web/index.html (a green rounded square
// with a white "M"), on the standard macOS icon grid (an 824 px square on a 1024 px canvas).
//
//   swift mac/tools/make-icon.swift <out.iconset>
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write(Data("usage: swift make-icon.swift <out.iconset>\n".utf8))
    exit(2)
}
let out = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: CGFloat(px) / 1024, y: CGFloat(px) / 1024)
    ctx.setShouldAntialias(true)
    let inset: CGFloat = 100, side: CGFloat = 824
    // The favicon's 32-unit grid (rx 7) scaled to the icon square.
    let unit = side / 32
    let square = CGRect(x: inset, y: inset, width: side, height: side)
    ctx.addPath(CGPath(roundedRect: square, cornerWidth: 7 * unit, cornerHeight: 7 * unit, transform: nil))
    ctx.setFillColor(CGColor(red: 0x2f / 255.0, green: 0x7a / 255.0, blue: 0x55 / 255.0, alpha: 1))
    ctx.fillPath()
    // M: M9 23 V9 l7 9 7-9 v14 (SVG y grows downwards; CoreGraphics y grows upwards).
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: inset + x * unit, y: inset + (32 - y) * unit) }
    ctx.move(to: p(9, 23))
    ctx.addLine(to: p(9, 9))
    ctx.addLine(to: p(16, 18))
    ctx.addLine(to: p(23, 9))
    ctx.addLine(to: p(23, 23))
    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.setLineWidth(2.6 * unit)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    ctx.strokePath()
    return ctx.makeImage()!
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        fatalError("cannot write \(url.path)")
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fatalError("cannot write \(url.path)") }
}

for base in [16, 32, 128, 256, 512] {
    writePNG(render(base), to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    writePNG(render(base * 2), to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
print("wrote \(out.path)")
