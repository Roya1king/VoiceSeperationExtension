import torch
import torch.nn as nn

class CausalConvBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, dilation):
        super().__init__()
        self.conv1 = nn.Conv1d(in_channels, out_channels, 1)
        self.prelu1 = nn.PReLU()
        self.norm1 = nn.GroupNorm(1, out_channels)
        
        # Causal padding = (kernel_size - 1) * dilation
        self.pad = (kernel_size - 1) * dilation
        self.depthwise = nn.Conv1d(out_channels, out_channels, kernel_size, 
                                   dilation=dilation, groups=out_channels)
        self.prelu2 = nn.PReLU()
        self.norm2 = nn.GroupNorm(1, out_channels)
        
        self.res_conv = nn.Conv1d(out_channels, in_channels, 1)

    def forward(self, x):
        res = x
        x = self.conv1(x)
        x = self.prelu1(x)
        x = self.norm1(x)
        
        # Apply causal padding on the left
        x = torch.nn.functional.pad(x, (self.pad, 0))
        x = self.depthwise(x)
        x = self.prelu2(x)
        x = self.norm2(x)
        
        x = self.res_conv(x)
        return x + res

class CausalTCN(nn.Module):
    def __init__(self):
        super().__init__()
        # 16kHz audio input (encoder)
        self.encoder = nn.Conv1d(1, 256, kernel_size=16, stride=8, padding=0)
        
        # TCN blocks
        self.tcn_blocks = nn.ModuleList([
            CausalConvBlock(256, 128, kernel_size=3, dilation=2**i) for i in range(8)
        ])
        
        # 2 stems output (Vocals, Background) (decoder)
        self.decoder = nn.ConvTranspose1d(256, 2, kernel_size=16, stride=8, padding=0)

    def forward(self, x):
        # x: [batch=1, channels=1, time=2048]
        x = self.encoder(x)
        for block in self.tcn_blocks:
            x = block(x)
        out = self.decoder(x)
        # out: [batch=1, stems=2, time=2048]
        
        # We only care about the last 64ms (1024 samples) output
        return out[:, :, -1024:]

if __name__ == "__main__":
    model = CausalTCN()
    # Dummy input representing 128ms sliding window
    dummy_input = torch.randn(1, 1, 2048) 
    
    # Export to ONNX Opset 17, Float16 with static shapes
    torch.onnx.export(
        model, 
        dummy_input, 
        "model.onnx",
        export_params=True,
        opset_version=17,
        do_constant_folding=True,
        input_names=['input_audio'],
        output_names=['stems'],
        dynamic_axes=None # Static shapes for WebGPU optimization
    )
    print("Model successfully exported to model.onnx")
