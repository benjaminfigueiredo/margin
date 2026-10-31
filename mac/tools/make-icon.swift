// Draws Margin's app icon into an .iconset folder (for iconutil), with CoreGraphics only, so the
// icon is rebuilt identically on any Mac. It is "Threshold", the same geometry as web/favicon.svg
// (the favicon and the logo in the top bars): two piers and an arch over a threshold, on the
// standard macOS icon grid (an 824 px rounded square on a 1024 px canvas). Change both together.
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

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
let paper = rgb(0xF7F4EC), ink = rgb(0x141414), red = rgb(0xD7362B), yellow = rgb(0xF2B01E), blue = rgb(0x1F4E9E)

// A point on a circle, in the SVG's coordinates (y grows downwards; the context is flipped to match).
func onCircle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ angle: CGFloat) -> CGPoint {
    CGPoint(x: cx + r * cos(angle), y: cy + r * sin(angle))
}

func render(_ px: Int) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setShouldAntialias(true)
    // Work in web/favicon.svg's units: a 1024 square with y growing downwards.
    ctx.scaleBy(x: CGFloat(px) / 1024, y: CGFloat(px) / 1024)
    ctx.translateBy(x: 0, y: 1024)
    ctx.scaleBy(x: 1, y: -1)

    let square = CGPath(roundedRect: CGRect(x: 100, y: 100, width: 824, height: 824),
                        cornerWidth: 184, cornerHeight: 184, transform: nil)
    ctx.addPath(square)
    ctx.setFillColor(paper)
    ctx.fillPath()

    ctx.saveGState()
    ctx.addPath(square)
    ctx.clip()
    ctx.setFillColor(blue)
    ctx.fill(CGRect(x: 100, y: 820, width: 824, height: 104)) // the ground
    ctx.setFillColor(ink)
    ctx.fill(CGRect(x: 250, y: 380, width: 150, height: 440)) // left pier
    ctx.fill(CGRect(x: 624, y: 380, width: 150, height: 440)) // right pier
    // The arch: the upper half of a ring centred on (512, 380), outer radius 262, inner 112. Drawn
    // as fine polylines so no arc-direction convention can flip it in the flipped context: from the
    // left (angle pi) over the top (3pi/2, i.e. y = 380 - r) to the right (2pi), then back inside.
    let steps = 96
    let arch = CGMutablePath()
    for i in 0...steps {
        let a = CGFloat.pi + CGFloat.pi * CGFloat(i) / CGFloat(steps)
        let p = onCircle(512, 380, 262, a)
        if i == 0 { arch.move(to: p) } else { arch.addLine(to: p) }
    }
    for i in 0...steps {
        let a = 2 * CGFloat.pi - CGFloat.pi * CGFloat(i) / CGFloat(steps)
        arch.addLine(to: onCircle(512, 380, 112, a))
    }
    arch.closeSubpath()
    ctx.addPath(arch)
    ctx.setFillColor(red)
    ctx.fillPath()
    ctx.setFillColor(yellow)
    ctx.fill(CGRect(x: 400, y: 776, width: 224, height: 44)) // the threshold
    ctx.restoreGState()
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
